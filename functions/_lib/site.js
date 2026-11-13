/* =====================================================================
   Talli Parking — the events catalogue, rendered on the server (plan A2).

   The site's first server-side code. Cloudflare Pages runs the files in
   functions/ for the routes in _routes.json and serves everything else
   as the static files it always has.

     /events          every series with a night coming up, soonest first
     /events/<slug>   one series: what, where, when, each night, and the
                      booking flow under them (plan A3, BOOKING_FLOW)
     /sitemap.xml     the static pages, the catalogue and every series
     /go/<slug>       one site or parking area (plan A4): what its Locate
                      Us card opens. Directions first, then the next
                      nights to book there.

   Why on the server at all: the details of an event have to be in the
   HTML Google receives. What is left and what it costs is not — that is
   loaded in the browser afterwards by assets/events.js, so a page held in
   a cache is never wrong about availability.

   WHICH DATABASE. Chosen from the request's hostname by the same rule as
   assets/talli-config.js: talli.co.nz and www.talli.co.nz are production,
   every other host is test. Nothing else can choose it — there is no
   environment variable and no header that overrides it. scripts/check.sh
   asserts the two files agree host by host.

   WHAT IT READS. Only what the anon key can read, which is only what a
   customer may see: active series, and nights that are announced or on
   sale. The queries ask for those statuses by name as well, so a draft
   or cancelled night stays off these pages even if a policy is widened.

   Every non-production response carries noindex, in a header and in the
   page. scripts/build.sh writes _headers for staging, but _headers does
   not apply to a Function's response, so this file does it itself.
   ===================================================================== */

export const SITE = 'https://talli.co.nz';

// --- the environment switch, as in assets/talli-config.js -----------------

const PRODUCTION = {
  name: 'production',
  supabaseUrl: 'https://oxzwfemyavznykqixhvk.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94endmZW15YXZ6bnlrcWl4aHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2OTg4MDUsImV4cCI6MjEwMjI3NDgwNX0.' +
    'iBO1h71PWSbFVkqMZ8dxIJnVWmjjbRMIvO_OpCi-syQ',
};

const TEST = {
  name: 'test',
  supabaseUrl: 'https://uhdoverwvlxvyyctskle.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZG92ZXJ3dmx4dnl5Y3Rza2xlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzU2NTAsImV4cCI6MjEwMjg1MTY1MH0.' +
    'XTVReAgSp7l7D-mc-wgU8HBp4WHiiw9aFkEA8DIvdEE',
};

// The same list as PRODUCTION_HOSTS in assets/talli-config.js, and for the
// same reasons: talli.pages.dev is deliberately not on it.
export const PRODUCTION_HOSTS = [
  'talli.co.nz',
  'www.talli.co.nz',
];

export function projectFor(hostname) {
  const host = String(hostname || '').toLowerCase();
  return PRODUCTION_HOSTS.indexOf(host) !== -1 ? PRODUCTION : TEST;
}

// --- the static pages in the sitemap ---------------------------------------
//
// Every indexable *.html page in the repository root, as the extensionless
// address Cloudflare Pages serves it at. scripts/check.sh fails if a page is
// added without being listed here, or if a noindex page is.
export const STATIC_PAGES = [
  '/',
  '/getting-here',
  '/book',
  '/eden-park',
  '/terms',
  '/privacy',
];

// --- reading the database --------------------------------------------------

const LISTED = 'status=in.(announced,on_sale)';
const NIGHT_FIELDS =
  'id,name,night_label,venue,starts_at,online_sales_close_at,status,picture_path';
const SERIES_FIELDS = 'id,slug,name,kind,venue,summary,picture_path,sort_order';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function read(project, path) {
  const res = await fetch(project.supabaseUrl + '/rest/v1' + path, {
    headers: { apikey: project.anonKey, Authorization: 'Bearer ' + project.anonKey },
  });
  if (!res.ok) throw new Error('database answered ' + res.status);
  return res.json();
}

// Nights still to come that a customer may see, with their series.
// `!inner` drops a night whose series the anon key cannot read (inactive).
async function upcomingNights(project, now, seriesId) {
  return read(project,
    '/event?' + LISTED +
    '&starts_at=gt.' + encodeURIComponent(now.toISOString()) +
    (seriesId ? '&series_id=eq.' + encodeURIComponent(seriesId) : '') +
    '&order=starts_at.asc,id.asc' +
    '&select=' + NIGHT_FIELDS + ',series_id,event_series!inner(' + SERIES_FIELDS + ')');
}

// Every active series with at least one night to come, soonest first.
export async function loadCatalogue(project, now) {
  const nights = await upcomingNights(project, now);
  const bySeries = new Map();
  for (const n of nights) {
    const s = n.event_series;
    if (!s || !s.slug) continue;
    if (!bySeries.has(s.id)) bySeries.set(s.id, Object.assign({}, s, { nights: [] }));
    bySeries.get(s.id).nights.push(n);
  }
  return [...bySeries.values()].sort((a, b) =>
    a.nights[0].starts_at.localeCompare(b.nights[0].starts_at) ||
    (a.sort_order || 0) - (b.sort_order || 0) ||
    a.name.localeCompare(b.name));
}

// One series and its nights to come, or null if there is no such active
// series.
export async function loadSeries(project, slug, now) {
  if (!SLUG.test(slug || '')) return null;
  const rows = await read(project,
    '/event_series?slug=eq.' + encodeURIComponent(slug) + '&active=is.true' +
    '&select=' + SERIES_FIELDS + '&limit=1');
  if (!rows.length) return null;
  const series = rows[0];
  series.nights = await upcomingNights(project, now, series.id);
  return series;
}

// --- formatting --------------------------------------------------------------

const TZ = 'Pacific/Auckland';

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(iso, opts) {
  return new Date(iso).toLocaleString('en-NZ', Object.assign({ timeZone: TZ }, opts));
}

const longDate = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const time = (iso) =>
  fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, '').toLowerCase();

// "Sat 21 Nov" for one night, "3 nights from Fri 20 Nov" for several.
function whenLine(nights) {
  if (nights.length === 1) return shortDate(nights[0].starts_at);
  return nights.length + ' nights from ' + shortDate(nights[0].starts_at);
}

function nightTitle(night) {
  return night.night_label || night.name;
}

export function pictureUrl(project, path) {
  if (!path) return null;
  const clean = String(path).split('/').map(encodeURIComponent).join('/');
  return project.supabaseUrl + '/storage/v1/object/public/event-pictures/' + clean;
}

// Where a night stands, from the server's point of view. Whether any spaces
// are left is the browser's job (assets/events.js).
export function nightState(night, now) {
  if (night.status === 'announced') {
    return { key: 'soon', label: 'Coming soon', action: 'Tell me when it opens' };
  }
  const closed = night.online_sales_close_at && new Date(night.online_sales_close_at) <= now;
  if (closed) {
    return { key: 'closed', label: 'Online booking closed', action: 'Ask about a space' };
  }
  return { key: 'on_sale', label: 'On sale', action: 'Book parking' };
}

const KIND_LABEL = { concert: 'Concert', sport: 'Sport', other: 'Event' };

// --- structured data -------------------------------------------------------

// Where the venue is, for search engines. Only venues we are sure of; any
// other is named without an address rather than given a wrong one.
const VENUES = {
  'eden park': { streetAddress: 'Reimers Avenue, Kingsland', addressLocality: 'Auckland' },
};

function place(venue) {
  const known = VENUES[String(venue || '').trim().toLowerCase()];
  return {
    '@type': 'Place',
    name: venue || 'Eden Park',
    address: Object.assign({ '@type': 'PostalAddress', addressLocality: 'Auckland', addressCountry: 'NZ' },
      known || {}),
  };
}

// One schema.org Event per night. Prices are left out on purpose: they are
// loaded in the browser, and markup that disagrees with the page is worse
// than none.
export function eventJsonLd(project, series, url) {
  const type = series.kind === 'sport' ? 'SportsEvent'
    : series.kind === 'concert' ? 'MusicEvent' : 'Event';
  return series.nights.map((night) => {
    const picture = pictureUrl(project, night.picture_path || series.picture_path);
    const item = {
      '@context': 'https://schema.org',
      '@type': type,
      name: night.night_label ? series.name + ' — ' + night.night_label : night.name,
      startDate: night.starts_at,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: place(night.venue || series.venue),
      url: url + '#night-' + night.id,
      description: series.summary || describe(series),
    };
    if (picture) item.image = [picture];
    if (series.kind === 'concert') item.performer = { '@type': 'PerformingGroup', name: series.name };
    if (series.kind === 'sport') item.homeTeam = { '@type': 'SportsTeam', name: series.name };
    return item;
  });
}

// JSON inside <script> ends at the first "</script", whatever the JSON
// says. Escaping "<" closes that door for any text a series can hold.
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function describe(series) {
  const venue = series.venue || 'Eden Park';
  const nights = series.nights || [];
  if (!nights.length) return 'Parking a short walk from ' + venue + ' for ' + series.name + '.';
  const when = nights.length === 1
    ? longDate(nights[0].starts_at)
    : nights.length + ' nights from ' + longDate(nights[0].starts_at);
  return 'Parking a short walk from ' + venue + ' for ' + series.name + ', ' + when +
    '. Book a driveway space online in under a minute.';
}

// --- the booking flow (plan A3) ----------------------------------------------
//
// Steps 2–4 of the booking flow and the "tell me" sheet, as book.html has
// them. assets/booking.js drives them on both pages; step 1 here is the
// list of nights above. tests/units/event-pages.test.js checks that this
// and book.html both carry every element booking.js looks for.

export const BOOKING_FLOW = `<div class="bk-flow ev-flow">

    <section class="bk-step" id="bk-tiers-step" aria-labelledby="bk-h-tier" hidden>
      <div class="bk-step-head">
        <span class="bk-step-num">02</span>
        <h2 id="bk-h-tier">Where to park?</h2>
      </div>
      <p class="bk-step-context" id="bk-tier-event"></p>
      <div class="bk-chips" id="bk-types" role="radiogroup" aria-label="Type of space"></div>
      <p class="bk-step-note" id="bk-type-note" hidden></p>
      <p class="bk-step-note bk-surcharge-note" id="bk-tier-surcharge" hidden></p>
      <div class="bk-map" id="bk-map" role="region" aria-label="Map of parking near Eden Park" hidden></div>
      <div class="bk-cards" id="bk-blocks"></div>
    </section>

    <section class="bk-step" id="bk-extras-step" aria-labelledby="bk-h-extras" hidden>
      <div class="bk-step-head">
        <span class="bk-step-num">03</span>
        <h2 id="bk-h-extras">Anything else?</h2>
      </div>
      <p class="bk-step-note">
        Worth deciding now rather than in the rain. Add them here and they&rsquo;ll be
        waiting when you pull in &mdash; no cash, no queue. Skip straight past if you&rsquo;re sorted.
      </p>
      <div class="bk-extras" id="bk-extras"></div>
    </section>

    <section class="bk-step" id="bk-details" aria-labelledby="bk-h-details" hidden>
      <div class="bk-step-head">
        <span class="bk-step-num">04</span>
        <h2 id="bk-h-details">Your details</h2>
      </div>

      <div class="bk-summary">
        <div class="bk-summary-line">
          <span class="bk-summary-tier" id="bk-summary-tier"></span>
          <span class="bk-summary-price" id="bk-summary-price"></span>
        </div>
        <div class="bk-summary-extras" id="bk-summary-extras" hidden></div>
        <div class="bk-summary-line bk-summary-extra bk-summary-surcharge" id="bk-summary-surcharge" hidden>
          <span id="bk-summary-surcharge-label">Card payment surcharge</span>
          <span id="bk-summary-surcharge-price"></span>
        </div>
        <div class="bk-summary-total" id="bk-summary-total" hidden>
          <span>Total</span>
          <strong id="bk-summary-total-price"></strong>
        </div>
        <div class="bk-summary-meta" id="bk-summary-event"></div>
        <div class="bk-summary-meta" id="bk-summary-arrival" hidden></div>
      </div>

      <form id="bk-form">
        <div class="bk-field">
          <label for="bk-name">Name</label>
          <input type="text" id="bk-name" name="name" autocomplete="name" required>
        </div>
        <div class="bk-field">
          <label for="bk-email">Email</label>
          <input type="email" id="bk-email" name="email" autocomplete="email" required>
          <span class="bk-hint">Your receipt and arrival instructions go here.</span>
        </div>
        <div class="bk-field-row">
          <div class="bk-field">
            <label for="bk-phone">Phone <span class="bk-optional">optional</span></label>
            <input type="tel" id="bk-phone" name="phone" autocomplete="tel">
          </div>
          <div class="bk-field">
            <label for="bk-rego">Number plate</label>
            <input type="text" id="bk-rego" name="rego" required maxlength="8" autocapitalize="characters" spellcheck="false">
            <span class="bk-hint">Helps us find you fast. Add it later if you don't know it yet.</span>
          </div>
        </div>
        <div class="bk-check-field">
          <label class="bk-check" for="bk-low">
            <input type="checkbox" id="bk-low" name="low">
            <span>My car is lowered or sits low to the ground</span>
          </label>
          <span class="bk-hint">
            Some spots have a steep entry. Tick this and the marshal will put you
            somewhere flat &mdash; it costs nothing and doesn&rsquo;t change your spot.
          </span>
        </div>

        <p class="bk-error" id="bk-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary bk-submit" id="bk-submit">Continue to payment</button>
        <p class="bk-fineprint">
          You&rsquo;ll be taken to Stripe to pay by card. Your space is held while you check out.
          A marshal will show you where to park on the night. Your vehicle needs a current WOF and
          registration. By booking you agree to our <a href="/terms">terms &amp; conditions</a>.
        </p>
      </form>
    </section>

  </div>`;

const INTEREST_SHEET = `<div class="bk-sheet" id="bk-interest" hidden>
  <div class="bk-sheet-card">
    <div class="bk-sheet-head">
      <div>
        <h2 id="bk-interest-name"></h2>
        <p class="bk-sheet-when" id="bk-interest-when"></p>
      </div>
      <button type="button" class="bk-sheet-close" id="bk-interest-close" aria-label="Close">&times;</button>
    </div>
    <p class="bk-sheet-lead" id="bk-interest-lead"></p>
    <form id="bk-interest-form">
      <div class="bk-field">
        <label for="bk-interest-email">Email</label>
        <input type="email" id="bk-interest-email" name="interestemail" autocomplete="email" required>
      </div>
      <div class="bk-field">
        <label for="bk-interest-yourname">Name <span class="bk-optional">optional</span></label>
        <input type="text" id="bk-interest-yourname" name="interestname" autocomplete="name">
      </div>
      <p class="bk-error" id="bk-interest-error" role="alert" hidden></p>
      <button type="submit" class="btn btn-primary" id="bk-interest-submit">Tell me when it opens</button>
      <p class="bk-fineprint">We&rsquo;ll only email you about this event. No newsletter, and we don&rsquo;t share your address.</p>
    </form>
    <p class="bk-sheet-done" id="bk-interest-done" role="status" hidden></p>
  </div>
</div>`;

// --- the page around it ------------------------------------------------------

function page(opts) {
  const robots = opts.noindex ? '\n<meta name="robots" content="noindex, nofollow, noarchive">' : '';
  const og = [
    ['og:type', 'website'],
    ['og:site_name', 'Talli Parking'],
    ['og:title', opts.title],
    ['og:description', opts.description],
    ['og:url', opts.canonical],
  ];
  if (opts.image) og.push(['og:image', opts.image]);
  const ld = opts.jsonLd && opts.jsonLd.length
    ? '\n<script type="application/ld+json">' + scriptJson(opts.jsonLd) + '</script>'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">${robots}
<link rel="canonical" href="${esc(opts.canonical)}">
${og.map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join('\n')}
<meta name="twitter:card" content="${opts.image ? 'summary_large_image' : 'summary'}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poiret+One&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">${opts.booking ? '\n<link rel="stylesheet" href="/assets/vendor/leaflet/leaflet.css">' : ''}
<link rel="stylesheet" href="/style.css">
<script src="/assets/talli-config.js"></script>
<script src="/assets/talli-testgate.js"></script>${ld}
</head>
<body>

<div class="topbar">
  <div class="topbar-inner">
    <a href="/"><img class="brand-logo" src="/assets/talli-logo.png" alt="talli."></a>
    <nav class="topnav">
      <a href="/">Home</a>
      <a href="/events"${opts.nav === 'here' ? '' : ' class="active"'}>What's On</a>
      <a href="/getting-here"${opts.nav === 'here' ? ' class="active"' : ''}>Getting Here</a>
      <a href="/book">Book &amp; Extras</a>
      <a href="/eden-park">Eden Park Guide</a>
    </nav>
  </div>
</div>

${opts.body}

<footer>
  <div class="footer-inner">
    <div>
      <strong>Talli Parking</strong><br>
      86 Paice Ave, Sandringham, Auckland<br>
      <a href="/terms" style="font-size: 0.85em; text-decoration: underline;">Terms &amp; Conditions</a>
      &nbsp;<a href="/privacy" style="font-size: 0.85em; text-decoration: underline;">Privacy</a>
    </div>
    <div>
      Book or ask a question:<br>
      <a href="mailto:bookings@talli.co.nz">bookings@talli.co.nz</a>
    </div>
  </div>
</footer>

${opts.booking ? INTEREST_SHEET + '\n\n' : ''}<script src="/assets/events.js"></script>${opts.booking
    ? '\n<script src="/assets/vendor/leaflet/leaflet.js"></script>\n<script src="/assets/booking.js"></script>'
    : ''}
</body>
</html>
`;
}

function dateBlock(iso) {
  return '<span class="bk-date" aria-hidden="true">' +
    `<span class="bk-date-dow">${esc(fmt(iso, { weekday: 'short' }))}</span>` +
    `<span class="bk-date-day">${esc(fmt(iso, { day: 'numeric' }))}</span>` +
    `<span class="bk-date-mon">${esc(fmt(iso, { month: 'short' }))}</span>` +
    '</span>';
}

// --- /events -------------------------------------------------------------------

export function renderCatalogue(project, list, opts) {
  const cards = list.map((s) => {
    const picture = pictureUrl(project, s.picture_path || s.nights[0].picture_path);
    const ids = s.nights.map((n) => n.id).join(',');
    return `    <li class="ev-card">
      <a class="ev-card-link" href="/events/${esc(s.slug)}">
        ${picture
          ? `<img class="ev-card-pic" src="${esc(picture)}" alt="" loading="lazy">`
          : '<span class="ev-card-pic ev-card-pic-none" aria-hidden="true"></span>'}
        <span class="ev-card-body">
          <span class="ev-card-kind">${esc(KIND_LABEL[s.kind] || 'Event')} · ${esc(s.venue || 'Eden Park')}</span>
          <span class="ev-card-name">${esc(s.name)}</span>
          <span class="ev-card-when">${esc(whenLine(s.nights))}</span>
          <span class="ev-from" data-event-ids="${esc(ids)}"></span>
        </span>
      </a>
    </li>`;
  }).join('\n');

  const body = `<header class="hero compact">
  <div class="hero-rule"></div>
  <span class="eyebrow">Eden Park parking</span>
  <h1>What's on</h1>
  <p>Pick the event, then the night. Every one listed has driveway parking a short walk from the gates.</p>
</header>

<main class="wrap tight">
${list.length
    ? `  <ul class="ev-list">\n${cards}\n  </ul>`
    : `  <p class="ev-empty">Nothing on the calendar just now. We take arrivals on the night as well —
  see <a href="/getting-here">Getting Here</a>, or email
  <a href="mailto:bookings@talli.co.nz">bookings@talli.co.nz</a>.</p>`}
</main>`;

  const first = list.find((s) => s.picture_path || s.nights[0].picture_path);
  return page({
    title: "What's on at Eden Park — parking by event | Talli Parking",
    description: list.length
      ? 'Parking a short walk from Eden Park for ' +
        list.slice(0, 4).map((s) => s.name).join(', ') +
        (list.length > 4 ? ' and more' : '') + '. Pick your event and book a driveway space online.'
      : 'Parking a short walk from Eden Park. Pick your event and book a driveway space online.',
    canonical: SITE + '/events',
    image: first ? pictureUrl(project, first.picture_path || first.nights[0].picture_path) : null,
    noindex: opts.noindex,
    body,
  });
}

// --- /events/<slug> ------------------------------------------------------------

export function renderSeries(project, series, opts) {
  const now = opts.now;
  const url = SITE + '/events/' + series.slug;
  const picture = pictureUrl(project, series.picture_path);

  const nights = series.nights.map((n) => {
    const state = nightState(n, now);
    const nightPicture = n.picture_path ? pictureUrl(project, n.picture_path) : null;
    // The data-night-* attributes are what assets/booking.js needs to open
    // the flow for this night without asking the database what it is.
    const fullName = n.night_label ? series.name + ' — ' + n.night_label : n.name;
    return `    <li class="ev-night is-${state.key}" id="night-${esc(n.id)}"
        data-night-id="${esc(n.id)}" data-night-state="${esc(state.key)}"
        data-night-name="${esc(fullName)}" data-night-starts="${esc(n.starts_at)}">
      ${dateBlock(n.starts_at)}
      <span class="ev-night-body">
        <span class="ev-night-name">${esc(nightTitle(n))}</span>
        <span class="ev-night-meta"><time datetime="${esc(n.starts_at)}">${esc(longDate(n.starts_at))}, ${esc(time(n.starts_at))}</time> · ${esc(n.venue || series.venue || 'Eden Park')}</span>
        <span class="ev-night-status">${esc(state.label)}</span>
        <span class="ev-from" data-event-ids="${esc(n.id)}"></span>
      </span>
      ${nightPicture ? `<img class="ev-night-pic" src="${esc(nightPicture)}" alt="" loading="lazy">` : ''}
      <a class="btn ${state.key === 'on_sale' ? 'btn-primary' : 'btn-outline'} ev-night-go"
         href="/events/${esc(series.slug)}?night=${esc(encodeURIComponent(n.id))}">${esc(state.action)}</a>
    </li>`;
  }).join('\n');

  const body = `<header class="hero compact ev-hero">
  <div class="hero-rule"></div>
  <a class="eyebrow ev-crumb" href="/events">What's on</a>
  <h1>${esc(series.name)}</h1>
  <p class="ev-where">${esc(KIND_LABEL[series.kind] || 'Event')} · ${esc(series.venue || 'Eden Park')}</p>
  ${series.summary ? `<p>${esc(series.summary)}</p>` : ''}
  ${picture ? `<img class="ev-hero-pic" src="${esc(picture)}" alt="${esc(series.name)}">` : ''}
</header>

<main class="wrap tight">
  <div class="bk-step-head ev-step-head">
    <span class="bk-step-num">01</span>
    <h2>${series.nights.length === 1 ? 'The night' : 'Pick your night'}</h2>
  </div>
${series.nights.length
    ? `  <ul class="ev-nights" id="bk-nights">\n${nights}\n  </ul>
  <p class="ev-note">Parking is in driveways a few minutes' walk from the gates. Prices are set per area
  and type of space, and the price you see when you book is the price you pay.</p>

  ${BOOKING_FLOW}`
    : `  <p class="ev-empty">No nights on sale for ${esc(series.name)} just now.
  <a href="/events">See what else is on</a>.</p>`}
</main>`;

  return page({
    title: series.name + ' — parking near ' + (series.venue || 'Eden Park') + ' | Talli Parking',
    description: describe(series),
    canonical: url,
    image: picture,
    // A series with nothing coming up has nothing to offer a searcher.
    noindex: opts.noindex || !series.nights.length,
    jsonLd: eventJsonLd(project, series, url),
    booking: series.nights.length > 0,
    body,
  });
}

export function renderNotFound(opts) {
  return page({
    title: 'Not found | Talli Parking',
    description: 'That event is not on the calendar.',
    canonical: SITE + '/events',
    noindex: true,
    body: `<header class="hero compact">
  <div class="hero-rule"></div>
  <h1>Not on the calendar</h1>
  <p>We could not find that event. It may have finished, or the address may have changed.</p>
  <div class="btn-row"><a class="btn btn-primary" href="/events">See what's on</a></div>
</header>`,
  });
}

function renderUnavailable(opts) {
  // A driver who scanned a card at the kerb: the address is on the card
  // in front of them, so say that rather than point them at booking.
  if (opts.place) {
    return page({
      title: 'Back shortly | Talli Parking',
      description: 'Directions are not available just now.',
      canonical: SITE + '/getting-here',
      noindex: true,
      nav: 'here',
      body: `<header class="hero compact">
  <div class="hero-rule"></div>
  <h1>Back in a moment</h1>
  <p>We could not load the directions just now. The address is on the card, and in your booking
  confirmation. Please try this page again shortly.</p>
</header>`,
    });
  }
  return page({
    title: 'Back shortly | Talli Parking',
    description: 'The events list is not available just now.',
    canonical: SITE + '/events',
    noindex: true,
    body: `<header class="hero compact">
  <div class="hero-rule"></div>
  <h1>Back in a moment</h1>
  <p>We could not load the events just now. Please try again shortly, or
  <a href="/book">go straight to booking</a>.</p>
</header>`,
  });
}

// --- /go/<slug> (plan A4) ------------------------------------------------------
//
// What a Locate Us card opens. Scanning goes to the Talli site on purpose,
// not straight to a map: the directions are one tap away, and the next
// nights to book are underneath them. A printed card carries this address,
// so the page reads its position from the database each time and a card
// never needs reprinting when a position is corrected.
//
// A slug names a site (its own driveway) or a block (the area a customer
// books: its anchor's address "or a driveway within 100m"). Both are read
// with the anon key: active sites and blocks, their addresses, positions
// and pictures, which are public by design. The bank details a warden's
// Site guide shows are not readable here, and this file never asks.

const PLACE_SITE_FIELDS = 'id,name,address,lat,lng,walk_minutes,slug,block_id';
const PICTURES = 'site_picture(path,caption,sort_order)';

export function sitePictureUrl(project, path) {
  if (!path) return null;
  const clean = String(path).split('/').map(encodeURIComponent).join('/');
  return project.supabaseUrl + '/storage/v1/object/public/site-pictures/' + clean;
}

const byOrder = (a, b) => (a.sort_order || 0) - (b.sort_order || 0);

// "86 Paice Avenue, Sandringham, Auckland 1025" → "86 Paice Avenue". The
// part a driver looks for on a letterbox. Brackets (test sites) dropped.
export function streetOf(address) {
  return String(address || '').split(',')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
}

// Where a map should take someone: the position when there is one, which
// lands on the driveway, else the address.
export function mapLinks(place) {
  const to = place.lat != null && place.lng != null
    ? place.lat + ',' + place.lng
    : place.address;
  return {
    google: 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(to),
    apple: 'https://maps.apple.com/?daddr=' + encodeURIComponent(to) + '&saddr=Current+Location',
  };
}

// The site or block a slug names, as one shape the page draws, or null.
export async function loadPlace(project, slug, now) {
  if (!SLUG.test(slug || '')) return null;
  let place = null;
  let siteIds = [];

  const sites = await read(project,
    '/property?slug=eq.' + encodeURIComponent(slug) + '&active=is.true' +
    '&select=' + PLACE_SITE_FIELDS + ',' + PICTURES + '&limit=1');
  if (sites.length) {
    const p = sites[0];
    place = {
      kind: 'site', slug: p.slug, name: p.name, address: p.address || p.name,
      lat: p.lat, lng: p.lng, walk_minutes: p.walk_minutes,
      pictures: (p.site_picture || []).slice().sort(byOrder),
    };
    siteIds = [p.id];
    if (p.block_id) {
      const rows = await read(project, '/property?active=is.true&block_id=eq.' +
        encodeURIComponent(p.block_id) + '&select=id');
      siteIds = rows.map((r) => r.id);
    }
  } else {
    const blocks = await read(project,
      '/block?slug=eq.' + encodeURIComponent(slug) + '&active=is.true' +
      '&select=id,name,slug,lat,lng,anchor:anchor_property_id(' +
      PLACE_SITE_FIELDS + ',active,' + PICTURES + ')&limit=1');
    if (!blocks.length) return null;
    const b = blocks[0];
    const a = b.anchor && b.anchor.active ? b.anchor : null;
    const rows = await read(project, '/property?active=is.true&block_id=eq.' +
      encodeURIComponent(b.id) + '&select=id');
    siteIds = rows.map((r) => r.id);
    // A block with no active anchor has nowhere to send anyone.
    if (!a) return null;
    place = {
      kind: 'block', slug: b.slug, name: b.name, address: a.address || a.name,
      lat: a.lat != null ? a.lat : b.lat, lng: a.lng != null ? a.lng : b.lng,
      walk_minutes: a.walk_minutes,
      pictures: (a.site_picture || []).slice().sort(byOrder),
      several: siteIds.length > 1,
    };
  }

  place.nights = [];
  if (siteIds.length) {
    // The nights this area takes part in: an offer that is on sale or
    // waiting on its host. A paused one sells nothing online.
    const offers = await read(project, '/event_offer?status=in.(confirmed,pending)' +
      '&property_id=in.(' + siteIds.map(encodeURIComponent).join(',') + ')&select=event_id');
    const ids = [...new Set(offers.map((o) => o.event_id))];
    if (ids.length) {
      place.nights = (await read(project,
        '/event?' + LISTED + '&id=in.(' + ids.map(encodeURIComponent).join(',') + ')' +
        '&starts_at=gt.' + encodeURIComponent(now.toISOString()) +
        '&order=starts_at.asc,id.asc&limit=8' +
        '&select=' + NIGHT_FIELDS + ',event_series!inner(' + SERIES_FIELDS + ')'))
        .filter((n) => n.event_series && n.event_series.slug);
    }
  }
  return place;
}

export function renderPlace(project, place, opts) {
  const now = opts.now;
  const url = SITE + '/go/' + place.slug;
  const street = streetOf(place.address) || place.name;
  const maps = mapLinks(place);
  const first = place.pictures[0] ? sitePictureUrl(project, place.pictures[0].path) : null;

  const walk = place.walk_minutes != null
    ? `<p class="go-walk">${esc(place.walk_minutes)} min walk to Eden Park</p>` : '';
  const where = place.kind === 'block' && place.several
    ? `<p class="go-note">Come to ${esc(street)}. A Talli warden will meet you and show you which
  driveway to park in — it may be one of the neighbours within 100m.</p>`
    : `<p class="go-note">A Talli warden will meet you on the driveway and show you where to park.</p>`;

  const pictures = place.pictures.map((pic) => `    <figure class="go-pic">
      <img src="${esc(sitePictureUrl(project, pic.path))}" alt="${esc(pic.caption || 'Where to park at ' + street)}" loading="lazy">
      ${pic.caption ? `<figcaption>${esc(pic.caption)}</figcaption>` : ''}
    </figure>`).join('\n');

  const nights = place.nights.map((n) => {
    const s = n.event_series;
    const state = nightState(n, now);
    return `    <li class="go-night">
      <a class="go-night-link" href="/events/${esc(s.slug)}?night=${esc(encodeURIComponent(n.id))}">
        ${dateBlock(n.starts_at)}
        <span class="go-night-body">
          <span class="go-night-name">${esc(s.name)}${n.night_label ? ' — ' + esc(n.night_label) : ''}</span>
          <span class="go-night-meta">${esc(longDate(n.starts_at))}, ${esc(time(n.starts_at))} · ${esc(state.label)}</span>
        </span>
        <span class="go-night-go">${esc(state.action)} →</span>
      </a>
    </li>`;
  }).join('\n');

  const body = `<header class="hero compact go-hero">
  <div class="hero-rule"></div>
  <span class="eyebrow">Locate us · Talli Parking</span>
  <h1>${esc(street)}</h1>
  <p class="go-address">${esc(place.address)}</p>
  ${walk}
</header>

<main class="wrap tight go-main">
  <div class="btn-row go-maps">
    <a class="btn btn-primary" id="go-google" href="${esc(maps.google)}" target="_blank" rel="noopener">Open in Google Maps</a>
    <a class="btn btn-outline" id="go-apple" href="${esc(maps.apple)}" target="_blank" rel="noopener">Open in Apple Maps</a>
  </div>
  ${where}
${pictures ? `  <div class="go-pics">\n${pictures}\n  </div>` : ''}

  <hr class="thin">

  <div class="section-label">Next time</div>
  <h2>Book your space here</h2>
${place.nights.length
    ? `  <ul class="go-nights">\n${nights}\n  </ul>`
    : `  <p class="ev-empty">Nothing on sale here just now.</p>`}
  <div class="btn-row"><a class="btn btn-outline" href="/events">See everything on at Eden Park</a></div>
</main>`;

  return page({
    title: street + ' — parking near Eden Park | Talli Parking',
    description: 'Directions to Talli Parking at ' + street + ', ' +
      (place.walk_minutes != null ? place.walk_minutes + ' minutes\u2019 walk' : 'a short walk') +
      ' from Eden Park. Open in Google Maps or Apple Maps, and book your space for next time.',
    canonical: url,
    image: first,
    noindex: opts.noindex,
    nav: 'here',
    body,
  });
}

function renderPlaceNotFound() {
  return page({
    title: 'Not found | Talli Parking',
    description: 'That parking address is not one we know.',
    canonical: SITE + '/getting-here',
    noindex: true,
    nav: 'here',
    body: `<header class="hero compact">
  <div class="hero-rule"></div>
  <h1>We could not find that address</h1>
  <p>It may have been typed slightly differently from the card. Pick your parking area from the list.</p>
  <div class="btn-row"><a class="btn btn-primary" href="/getting-here">Getting Here</a></div>
</header>`,
  });
}

// --- /sitemap.xml -------------------------------------------------------------

export function renderSitemap(list) {
  const urls = STATIC_PAGES.map((p) => SITE + p)
    .concat([SITE + '/events'])
    .concat(list.map((s) => SITE + '/events/' + s.slug));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n') +
    '\n</urlset>\n';
}

// --- the handlers ---------------------------------------------------------------
//
// Each takes the request and the project to read. The functions in
// functions/ pass projectFor(hostname) and nothing else; the test suites
// pass the local stack.

function headers(type, project, extra) {
  const h = new Headers({
    'Content-Type': type,
    // Short: the details change rarely, but a night does go on sale.
    'Cache-Control': 'public, max-age=300',
  });
  if (project !== PRODUCTION) h.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  for (const [k, v] of Object.entries(extra || {})) h.set(k, v);
  return h;
}

const HTML = 'text/html; charset=utf-8';

function unavailable(project, opts) {
  return new Response(renderUnavailable(opts || {}), {
    status: 503,
    headers: headers(HTML, project, { 'Cache-Control': 'no-store', 'Retry-After': '60' }),
  });
}

export async function handleCatalogue(request, project, now = new Date()) {
  let list;
  try { list = await loadCatalogue(project, now); } catch (e) { return unavailable(project); }
  return new Response(renderCatalogue(project, list, { noindex: project !== PRODUCTION }), {
    headers: headers(HTML, project),
  });
}

export async function handleSeries(request, project, slug, now = new Date()) {
  let series;
  try { series = await loadSeries(project, slug, now); } catch (e) { return unavailable(project); }
  if (!series) {
    return new Response(renderNotFound({}), {
      status: 404,
      headers: headers(HTML, project, { 'Cache-Control': 'public, max-age=60' }),
    });
  }
  return new Response(renderSeries(project, series, { now, noindex: project !== PRODUCTION }), {
    headers: headers(HTML, project),
  });
}

export async function handleSitemap(request, project, now = new Date()) {
  let list = [];
  // Without the database, the static pages are still worth listing.
  try { list = await loadCatalogue(project, now); } catch (e) { list = []; }
  return new Response(renderSitemap(list), {
    headers: headers('application/xml; charset=utf-8', project),
  });
}

// /go/<slug>. A slug typed from a photo of the card may come in with
// capitals; it is sent to the lower-case address rather than refused.
export async function handlePlace(request, project, slug, now = new Date()) {
  const raw = String(slug || '').trim();
  if (raw && raw.toLowerCase() !== raw && SLUG.test(raw.toLowerCase())) {
    return new Response(null, {
      status: 301,
      headers: headers(HTML, project, { Location: '/go/' + raw.toLowerCase() }),
    });
  }
  let place;
  try { place = await loadPlace(project, raw, now); } catch (e) { return unavailable(project, { place: true }); }
  if (!place) {
    return new Response(renderPlaceNotFound(), {
      status: 404,
      headers: headers(HTML, project, { 'Cache-Control': 'public, max-age=60' }),
    });
  }
  return new Response(renderPlace(project, place, { now, noindex: project !== PRODUCTION }), {
    headers: headers(HTML, project),
  });
}

// /go on its own: the list of every area.
export function handleGoIndex(request, project) {
  return new Response(null, {
    status: 302,
    headers: headers(HTML, project, { Location: '/getting-here' }),
  });
}
