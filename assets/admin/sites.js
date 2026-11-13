/* Talli Parking — gate screen: sites.js

   The Sites page (plan B3). Andrew's alone. Everything about a driveway
   in one place, so a new site goes from an address to on sale with no
   SQL and no visit to the Event tab:

     Details  — name, address, host, area, map position, walking time,
                site guide, fill notes, active, and the area's anchor.
     Spaces   — its usual numbers per type, or, with a night picked at the
                top, that night's actual numbers (never below what sold).
     Nights   — which upcoming nights it sells, as ticks, and the one tap
                that puts it on sale online for each.
     Prices   — its area's adjustment per type from the reference site.

   Every rule — a booked site does not move, the anchor stays in its area,
   a night's count is never below what has sold — is the database's. The
   page only says what it was told.
 */

import { CFG, asDate, button, call, el, make, show, state, text, toast } from './core.js';
import { loadList } from './night.js';

var SITE_TYPES = [
  { code: 'standard', label: 'Standard' },
  { code: 'priority', label: 'Priority exit' },
  { code: 'valet', label: 'Valet' },
];

var data = { sites: [], blocks: [], hosts: [], nights: [] };
// The night the Spaces section is showing, or '' for the usual numbers.
var nightFilter = '';

/* ------------------------------------------------------------ loading */

// selectId: the site to show. nightId: the night to show its numbers for
// ('' for the usual numbers); left out, the page keeps the one it had.
export function openSites(selectId, nightId) {
  if (nightId !== undefined) nightFilter = nightId || '';
  return call('sites_setup', {})
    .then(function (res) {
      data = {
        sites: res.sites || [],
        blocks: res.blocks || [],
        hosts: res.hosts || [],
        nights: res.nights || [],
      };
      fillSitePicker(selectId);
      fillNightPicker();
      renderSiteForm(el('ad-site-pick').value);
    })
    .catch(function (err) { toast(err.message, 'bad'); });
}

function fillSitePicker(selectId) {
  var pick = el('ad-site-pick');
  var keep = selectId || pick.value;
  pick.innerHTML = '';
  var group = null;
  var groupName = null;
  data.sites.forEach(function (s) {
    if (s.block_name !== groupName) {
      groupName = s.block_name;
      group = document.createElement('optgroup');
      group.label = groupName || 'No area';
      pick.appendChild(group);
    }
    var opt = document.createElement('option');
    opt.value = s.property_id;
    opt.textContent = s.name + (s.is_reference ? ' (reference)' : s.is_anchor ? ' (anchor)' : '') +
      (s.active ? '' : ' — off');
    group.appendChild(opt);
  });
  var add = document.createElement('option');
  add.value = '__new';
  add.textContent = '+ Add a new site…';
  pick.appendChild(add);
  var exists = data.sites.some(function (s) { return s.property_id === keep; });
  pick.value = keep === '__new' ? '__new'
    : exists ? keep : (data.sites[0] ? data.sites[0].property_id : '__new');
}

function fillNightPicker() {
  var pick = el('ad-site-night');
  pick.innerHTML = '';
  pick.appendChild(new Option('Usual numbers', ''));
  data.nights.forEach(function (n) {
    pick.appendChild(new Option(nightLabel(n), n.id));
  });
  if (!data.nights.some(function (n) { return n.id === nightFilter; })) nightFilter = '';
  pick.value = nightFilter;
}

// After a save: draw the page again from the server, and only then say it
// is saved, so nothing tapped after the message lands on a form about to
// be replaced.
function reload(siteId, message, nightId) {
  return openSites(siteId, nightId).then(function () { toast(message, 'good'); });
}

// The Event tab's "Change spaces" opens this page on its night.
export function presetNight(id) {
  nightFilter = id || '';
}

export function setNightFilter(id) {
  nightFilter = id || '';
  renderSiteForm(el('ad-site-pick').value);
}

function nightLabel(n) {
  return n.name + ' · ' + asDate(n.starts_at) + (n.is_live ? ' · live' : '');
}

function siteById(id) {
  return data.sites.filter(function (s) { return s.property_id === id; })[0] || null;
}
function blockById(id) {
  return data.blocks.filter(function (b) { return b.id === id; })[0] || null;
}
function nightById(id) {
  return data.nights.filter(function (n) { return n.id === id; })[0] || null;
}

/* ------------------------------------------------------------ helpers */

function numberInput(value, min) {
  var i = document.createElement('input');
  i.type = 'number';
  i.inputMode = 'numeric';
  i.min = String(min);
  i.step = '1';
  i.className = 'ad-input ad-num';
  i.value = value == null ? '' : String(value);
  return i;
}

function textInput(value, placeholder) {
  var i = document.createElement('input');
  i.type = 'text';
  i.className = 'ad-input';
  i.value = value == null ? '' : String(value);
  i.placeholder = placeholder || '';
  return i;
}

var fieldSeq = 0;
function field(box, labelText, input, help) {
  var wrap = make('div', 'ad-site-field');
  var label = make('label', 'ad-label', labelText);
  if (!input.id) input.id = 'ad-site-f' + (++fieldSeq);
  label.htmlFor = input.id;
  wrap.appendChild(label);
  wrap.appendChild(input);
  if (help) wrap.appendChild(make('p', 'ad-site-help', help));
  box.appendChild(wrap);
  return wrap;
}

function section(box, title, note) {
  box.appendChild(make('h2', 'ad-site-section', title));
  if (note) box.appendChild(make('p', 'ad-site-help', note));
}

function errorBox(box) {
  var err = make('p', 'ad-sheet-error');
  err.hidden = true;
  box.appendChild(err);
  return function (message) {
    if (message) { text(err, message); show(err); } else { err.hidden = true; }
  };
}

function primary(label, onClick) {
  return button('btn btn-primary ad-site-save', label, onClick);
}

// A select of hosts or areas, with a last option to name a new one. The
// name box under it shows only while that option is chosen.
function pickOrNew(box, labelText, items, current, newLabel, newPlaceholder) {
  var sel = document.createElement('select');
  sel.className = 'ad-select';
  items.forEach(function (it) { sel.appendChild(new Option(it.name, it.id)); });
  sel.appendChild(new Option(newLabel, '__new'));
  var known = items.some(function (it) { return it.id === current; });
  sel.value = known ? current : (current === '__new' || !items.length ? '__new' : items[0].id);
  field(box, labelText, sel);
  var name = textInput('', newPlaceholder);
  var wrap = field(box, newLabel.replace(/^\+\s*/, '').replace(/…$/, '') + ' — name', name);
  wrap.hidden = sel.value !== '__new';
  sel.addEventListener('change', function () { wrap.hidden = sel.value !== '__new'; });
  return {
    value: function () {
      return sel.value === '__new' ? { id: null, name: name.value.trim() } : { id: sel.value, name: null };
    },
  };
}

// "-36.88, 174.74", or any link with "@-36.88,174.74" or "/-36.88,174.74".
export function parsePosition(v) {
  // Anchored on what comes before, so "-136.1" is refused rather than
  // read as "36.1" — a pin in the wrong hemisphere.
  var m = String(v || '').match(/(^|[^\d.-])(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  var lat = Number(m[2]);
  var lng = Number(m[3]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lat, lng];
}

function positionText(lat, lng) {
  return lat == null || lng == null ? '' : Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6);
}

/* ---------------------------------------------------- the page itself */

export function renderSiteForm(id) {
  var box = el('ad-site-form');
  box.innerHTML = '';
  el('ad-site-night-row').hidden = id === '__new';
  if (id === '__new') { renderNewSite(box); return; }
  var site = siteById(id);
  if (!site) return;

  detailsSection(box, site);
  var night = nightFilter ? nightById(nightFilter) : null;
  if (night) nightSpacesSection(box, site, night);
  else usualSpacesSection(box, site);
  nightsSection(box, site);
  var block = blockById(site.block_id);
  if (block) pricingSection(box, block, site.property_id);
}

/* ------------------------------------------------------------ details */

function detailsSection(box, site) {
  section(box, 'Details');
  if (!site.active) {
    box.appendChild(make('p', 'ad-site-help ad-site-off',
      'Switched off: it sells nothing, and new nights leave it out.'));
  }

  var name = textInput(site.name);
  field(box, 'Site name', name);
  var address = textInput(site.address);
  var addressWrap = field(box, 'Address', address);
  var pos = textInput(positionText(site.lat, site.lng), '-36.880692, 174.742279');
  field(box, 'Map position', pos,
    'Two numbers, or a Google Maps link with them in it. Long-press the driveway in Google Maps to copy them.');
  attachPlaces(addressWrap, address, pos, null);

  var host = pickOrNew(box, 'Host', data.hosts, site.host_id, '+ New host…', 'Who gets paid for this driveway');
  var area = pickOrNew(box, 'Area', data.blocks, site.block_id, '+ New area…', 'e.g. Gribblehurst');

  var walk = numberInput(site.walk_minutes, 0);
  walk.classList.add('ad-site-short');
  field(box, 'Walk to the venue (minutes)', walk);
  var guide = textInput(site.site_guide_url, 'https://…');
  guide.type = 'url';
  field(box, 'Site guide (link to the marked-up picture)', guide);
  var notes = document.createElement('textarea');
  notes.className = 'ad-input ad-site-notes-input';
  notes.rows = 3;
  notes.value = site.fill_notes || '';
  field(box, 'Fill notes for the warden', notes);

  var activeRow = make('label', 'ad-site-apply');
  var active = document.createElement('input');
  active.type = 'checkbox';
  active.checked = !!site.active;
  activeRow.appendChild(active);
  activeRow.appendChild(document.createTextNode(' Active — can be added to nights and sold'));
  box.appendChild(activeRow);

  var say = errorBox(box);
  box.appendChild(primary('Save details', function () {
    var at = parsePosition(pos.value);
    if (pos.value.trim() && !at) { say('Couldn’t read a position from that.'); return; }
    var h = host.value();
    var a = area.value();
    if (!h.id && !h.name) { say('Pick a host or name a new one.'); return; }
    if (!a.id && !a.name) { say('Pick an area or name a new one.'); return; }
    say(null);
    var body = {
      property_id: site.property_id,
      name: name.value.trim(),
      address: address.value.trim(),
      lat: at ? at[0] : null,
      lng: at ? at[1] : null,
      walk_minutes: walk.value === '' ? null : Number(walk.value),
      site_guide_url: guide.value.trim(),
      fill_notes: notes.value.trim(),
      active: active.checked,
    };
    if (h.id) body.host_id = h.id; else body.new_host_name = h.name;
    if (a.id) body.block_id = a.id; else body.new_block_name = a.name;
    call('save_site_details', body)
      .then(function (res) {
        var msg = body.name + ' saved';
        if (res.nights_removed) msg += ' — off ' + res.nights_removed + ' upcoming night' +
          (res.nights_removed === 1 ? '' : 's');
        if (res.events_repriced) msg += ' — re-priced at its new area';
        reload(site.property_id, msg);
        if (state.eventId) loadList(true);
      })
      .catch(function (e) { say(explain(e)); });
  }));

  // The anchor is the address customers are told: "<anchor> or within
  // 100m". Always one of the area's own active sites.
  var block = blockById(site.block_id);
  if (block && site.active) {
    var line = make('p', 'ad-site-help ad-site-anchor');
    if (site.is_anchor) {
      line.textContent = 'This is the anchor of ' + block.name +
        ': customers are told “' + site.name + ' or within 100m”.';
    } else {
      var anchor = siteById(block.anchor_property_id);
      line.textContent = 'Anchor of ' + block.name + ': ' + (anchor ? anchor.name : 'none') + '. ';
      line.appendChild(button('ad-link', 'Make this the anchor', function () {
        call('set_block_anchor', { block_id: block.id, property_id: site.property_id })
          .then(function () {
            reload(site.property_id, site.name + ' is now the anchor of ' + block.name);
          })
          .catch(function (e) { toast(explain(e), 'bad'); });
      }));
    }
    box.appendChild(line);
  }
}

/* ------------------------------------------------------------- spaces */

function spacesTable(box, rows, withSold) {
  var table = make('div', 'ad-site-grid' + (withSold ? ' has-sold' : ''));
  table.appendChild(make('span', 'ad-site-h', 'Type'));
  table.appendChild(make('span', 'ad-site-h', 'Spaces'));
  table.appendChild(make('span', 'ad-site-h', 'Online'));
  if (withSold) table.appendChild(make('span', 'ad-site-h', 'Sold'));
  var inputs = {};
  rows.forEach(function (r) {
    var cap = numberInput(r.capacity, withSold ? r.sold || 0 : 0);
    var onl = numberInput(r.online, 0);
    cap.setAttribute('aria-label', r.label + ' spaces');
    onl.setAttribute('aria-label', r.label + ' sold online');
    inputs[r.code] = { cap: cap, onl: onl, sold: r.sold || 0, label: r.label };
    table.appendChild(make('span', 'ad-site-type', r.label));
    table.appendChild(cap);
    table.appendChild(onl);
    if (withSold) table.appendChild(make('span', 'ad-site-sold', String(r.sold || 0)));
  });
  box.appendChild(table);
  return inputs;
}

function readCounts(inputs, withSold) {
  var tiers = [];
  var bad = null;
  Object.keys(inputs).forEach(function (code) {
    var i = inputs[code];
    var c = parseInt(i.cap.value, 10) || 0;
    var o = parseInt(i.onl.value, 10) || 0;
    if (c < 0 || o < 0) bad = 'Counts can’t be negative.';
    else if (o > c) bad = i.label + ': online can’t be more than its spaces.';
    else if (withSold && c < i.sold) bad = i.label + ': ' + i.sold + ' already sold, so no fewer than that.';
    tiers.push({ code: code, capacity: c, online: o });
  });
  return { tiers: tiers, bad: bad };
}

function usualSpacesSection(box, site) {
  section(box, 'Usual spaces',
    'What this site has on a normal night. A night it joins starts from these. ' +
    'Online is how many sell on the website; the rest are kept for the warden to sell on the night.');
  var rows = SITE_TYPES.map(function (t) {
    var d = (site.defaults || []).filter(function (x) { return x.code === t.code; })[0] ||
      { capacity: 0, online: 0 };
    return { code: t.code, label: t.label, capacity: d.capacity, online: d.online };
  });
  var inputs = spacesTable(box, rows, false);

  var applyRow = make('label', 'ad-site-apply');
  var apply = document.createElement('input');
  apply.type = 'checkbox';
  apply.checked = false;
  applyRow.appendChild(apply);
  applyRow.appendChild(document.createTextNode(
    ' Also set every upcoming night this site sells to these (never below what has sold)'));
  box.appendChild(applyRow);

  var say = errorBox(box);
  box.appendChild(primary('Save usual spaces', function () {
    var read = readCounts(inputs, false);
    if (read.bad) { say(read.bad); return; }
    say(null);
    call('save_site', { property_id: site.property_id, tiers: read.tiers, apply_upcoming: apply.checked })
      .then(function (res) {
        var msg = site.name + ' saved';
        if (apply.checked) msg += ' — ' + (res.events_updated || 0) + ' upcoming night' +
          (res.events_updated === 1 ? '' : 's') + ' updated';
        if (res.kept_at_sold) msg += ' (' + res.kept_at_sold + ' kept at what had already sold)';
        reload(site.property_id, msg);
        if (state.eventId) loadList(true);
      })
      .catch(function (e) { say(explain(e)); });
  }));
}

function nightSpacesSection(box, site, night) {
  section(box, 'Spaces on ' + night.name, asDate(night.starts_at) +
    '. This night only: the usual numbers are not changed. Never below what has sold.');
  var offer = (site.nights || []).filter(function (n) { return n.event_id === night.id; })[0];
  if (!offer) {
    box.appendChild(make('p', 'ad-empty', site.name + ' is not selling this night. Tick it under Nights below.'));
    return;
  }
  box.appendChild(offerStatusLine(site, night, offer));
  var rows = SITE_TYPES.map(function (t) {
    var x = offer.tiers.filter(function (y) { return y.code === t.code; })[0];
    return x ? { code: t.code, label: t.label, capacity: x.capacity, online: x.online, sold: x.sold } : null;
  }).filter(Boolean);
  if (!rows.length) {
    box.appendChild(make('p', 'ad-empty', 'No types of space on this night yet.'));
    return;
  }
  var inputs = spacesTable(box, rows, true);
  var say = errorBox(box);
  box.appendChild(primary('Save spaces for this night', function () {
    var read = readCounts(inputs, true);
    if (read.bad) { say(read.bad); return; }
    say(null);
    call('save_site_night', { event_id: night.id, property_id: site.property_id, tiers: read.tiers })
      .then(function () {
        reload(site.property_id, site.name + ': ' + night.name + ' saved');
        if (state.eventId === night.id) loadList(true);
      })
      .catch(function (e) { say(explain(e)); });
  }));
}

/* ------------------------------------------------------------- nights */

// Pending until Andrew has heard back from the host; confirmed sells
// online; paused stops the website and leaves the gate working.
function offerStatusLine(site, night, offer) {
  var line = make('div', 'ad-site-line');
  line.appendChild(make('span', 'ad-chip is-' + offer.status,
    offer.status === 'confirmed' ? 'on sale' : offer.status));
  var next = offer.status === 'confirmed' ? 'paused' : 'confirmed';
  line.appendChild(button('ad-status-set', next === 'confirmed' ? 'Put on sale' : 'Pause online',
    function () {
      call('set_offer_status', { event_id: night.id, property_id: site.property_id, status: next })
        .then(function () {
          reload(site.property_id, site.name + (next === 'confirmed' ? ' on sale online' : ' paused online') +
            ' for ' + night.name);
          if (state.eventId === night.id) loadList(true);
        })
        .catch(function (e) { toast(explain(e), 'bad'); });
    }));
  return line;
}

function nightsSection(box, site) {
  section(box, 'Nights',
    'Tick the nights this site sells. It joins each one pending, at its usual spaces; ' +
    'putting it on sale online is a separate tap.');
  if (!data.nights.length) {
    box.appendChild(make('p', 'ad-empty', 'No nights coming up.'));
    return;
  }
  if (!site.active) {
    box.appendChild(make('p', 'ad-empty', 'Switch it back on to add it to nights.'));
    return;
  }

  var selling = {};
  (site.nights || []).forEach(function (o) { selling[o.event_id] = o; });

  var list = make('div', 'ad-site-nights');
  var allRow = make('label', 'ad-site-night-pick is-all');
  var all = document.createElement('input');
  all.type = 'checkbox';
  allRow.appendChild(all);
  allRow.appendChild(make('span', 'ad-site-night-name', 'All upcoming'));
  list.appendChild(allRow);

  var boxes = [];
  data.nights.forEach(function (n) {
    var row = make('div', 'ad-site-night');
    var label = make('label', 'ad-site-night-pick');
    var tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = !!selling[n.id];
    tick.value = n.id;
    label.appendChild(tick);
    label.appendChild(make('span', 'ad-site-night-name', nightLabel(n)));
    row.appendChild(label);
    if (selling[n.id]) row.appendChild(offerStatusLine(site, n, selling[n.id]));
    list.appendChild(row);
    boxes.push(tick);
  });
  function paintAll() {
    all.checked = boxes.every(function (b) { return b.checked; });
  }
  paintAll();
  boxes.forEach(function (b) { b.addEventListener('change', paintAll); });
  all.addEventListener('change', function () {
    boxes.forEach(function (b) { b.checked = all.checked; });
  });
  box.appendChild(list);
  if (site.is_reference) {
    box.appendChild(make('p', 'ad-site-help',
      'The reference site stays on every night it is in: the night’s prices are measured from it.'));
  }

  var say = errorBox(box);
  box.appendChild(primary('Save nights', function () {
    var add = [];
    var remove = [];
    boxes.forEach(function (b) {
      if (b.checked && !selling[b.value]) add.push(b.value);
      if (!b.checked && selling[b.value]) remove.push(b.value);
    });
    if (!add.length && !remove.length) { say('Nothing has changed.'); return; }
    say(null);
    call('set_site_nights', { property_id: site.property_id, add: add, remove: remove })
      .then(function (res) {
        var parts = [];
        if (res.added) parts.push('added to ' + res.added + ' night' + (res.added === 1 ? '' : 's'));
        if (res.removed) parts.push('taken off ' + res.removed + ' night' + (res.removed === 1 ? '' : 's'));
        reload(site.property_id, site.name + ' ' + parts.join(', '));
        if (state.eventId) loadList(true);
      })
      .catch(function (e) { say(explain(e)); });
  }));
}

/* ------------------------------------------------------------- prices */

// One price per area (plan B1): each type of park is the reference site's
// price plus this area's adjustment, the same at every driveway in it.
// The reference price itself moves on the Event tab.
function pricingSection(box, block, keepSite) {
  section(box, 'Prices in ' + block.name);
  if (block.is_reference) {
    box.appendChild(make('p', 'ad-site-help',
      'This is the reference area: every other area is priced from it. ' +
      'Change prices on the Event tab and every area follows.'));
    return;
  }

  var table = make('div', 'ad-site-grid is-two');
  table.appendChild(make('span', 'ad-site-h', 'Type'));
  table.appendChild(make('span', 'ad-site-h', '± $ vs reference'));
  var inputs = {};
  SITE_TYPES.forEach(function (t) {
    var cents = (block.offsets && block.offsets[t.code]) || 0;
    var i = numberInput(cents / 100, -100);
    i.setAttribute('aria-label', t.label + ' price difference in dollars');
    inputs[t.code] = i;
    table.appendChild(make('span', 'ad-site-type', t.label));
    table.appendChild(i);
  });
  box.appendChild(table);
  box.appendChild(make('p', 'ad-site-help',
    'e.g. -5 sells that type $5 under the reference site, at every driveway in ' +
    block.name + '. Saving re-prices its upcoming nights.'));

  var say = errorBox(box);
  box.appendChild(primary('Save prices for ' + block.name, function () {
    var offsets = [];
    var bad = null;
    SITE_TYPES.forEach(function (t) {
      var dollars = Number(inputs[t.code].value || 0);
      if (!Number.isFinite(dollars) || Math.abs(dollars) > 100) {
        bad = t.label + ': the difference must be between -$100 and $100.';
      }
      offsets.push({ code: t.code, offset_cents: Math.round(dollars * 100) });
    });
    if (bad) { say(bad); return; }
    say(null);
    call('save_block_pricing', { block_id: block.id, offsets: offsets })
      .then(function (res) {
        reload(keepSite, block.name + ' prices saved — ' + (res.events_updated || 0) + ' upcoming night' +
          (res.events_updated === 1 ? '' : 's') + ' re-priced');
        if (state.eventId) loadList(true);
      })
      .catch(function (e) { say(explain(e)); });
  }));
}

/* ----------------------------------------------------------- new site */

// A new driveway, starting from its address. The Places picker fills in
// the address and the position; both can still be typed.
function renderNewSite(box) {
  section(box, 'A new site',
    'Find the address, check the position, then say whose driveway it is and which area it is in. ' +
    'Its spaces and nights come next.');
  var address = textInput('', 'e.g. 70 Gribblehurst Road, Sandringham, Auckland');
  var addressWrap = field(box, 'Address', address);
  var pos = textInput('', '-36.880692, 174.742279 or a Google Maps link');
  var name = textInput('', 'e.g. 70 Gribblehurst');
  attachPlaces(addressWrap, address, pos, name);
  field(box, 'Map position', pos);
  field(box, 'Site name', name, 'Short: what the warden and the list call it.');
  var host = pickOrNew(box, 'Host', data.hosts, '__new', '+ New host…', 'Who gets paid for this driveway');
  var area = pickOrNew(box, 'Area', data.blocks, data.blocks[0] && data.blocks[0].id,
    '+ New area…', 'e.g. Gribblehurst');
  var walk = numberInput('', 0);
  walk.classList.add('ad-site-short');
  field(box, 'Walk to the venue (minutes)', walk);

  var say = errorBox(box);
  box.appendChild(primary('Add site', function () {
    var at = parsePosition(pos.value);
    if (pos.value.trim() && !at) { say('Couldn’t read a position from that.'); return; }
    var h = host.value();
    var a = area.value();
    if (!name.value.trim() || !address.value.trim()) { say('A name and an address are needed.'); return; }
    if (!h.id && !h.name) { say('Pick a host or name a new one.'); return; }
    if (!a.id && !a.name) { say('Pick an area or name a new one.'); return; }
    say(null);
    var body = {
      name: name.value.trim(),
      address: address.value.trim(),
      lat: at ? at[0] : null,
      lng: at ? at[1] : null,
      walk_minutes: walk.value === '' ? null : Number(walk.value),
    };
    if (h.id) body.host_id = h.id; else body.new_host_name = h.name;
    if (a.id) body.block_id = a.id; else body.new_block_name = a.name;
    call('add_site', body)
      .then(function (res) {
        reload(res.property_id, body.name + ' added — now set its usual spaces and tick its nights', '');
      })
      .catch(function (e) { say(explain(e)); });
  }));
}

/* ------------------------------------------------- Google Places picker */

// The Maps JavaScript API with the Places library, loaded once, only when
// the Sites page wants it. The key is the booking map's, which is
// referrer-restricted; Places API (New) has to be enabled for it in
// Google Cloud (DEPLOYMENT.md). If it is not, or the key is refused, the
// address and position are typed as before.
var placesReady = null;
function loadPlaces() {
  if (placesReady) return placesReady;
  placesReady = new Promise(function (resolve, reject) {
    if (!CFG.googleMapsKey) { reject(new Error('no key')); return; }
    if (window.google && window.google.maps && window.google.maps.importLibrary) { resolve(); return; }
    var cb = '__talliPlacesReady';
    window[cb] = function () { resolve(); };
    window.gm_authFailure = function () { reject(new Error('maps auth')); };
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' +
      encodeURIComponent(CFG.googleMapsKey) + '&callback=' + cb + '&loading=async';
    s.async = true;
    s.onerror = function () { reject(new Error('maps script')); };
    document.head.appendChild(s);
    setTimeout(function () { reject(new Error('maps timeout')); }, 8000);
  }).then(function () { return window.google.maps.importLibrary('places'); });
  return placesReady;
}

function attachPlaces(wrap, address, pos, name) {
  var note = make('p', 'ad-site-help', 'Address search is loading…');
  wrap.appendChild(note);
  function failed() {
    text(note, 'Address search is unavailable here: type the address, and paste the position from Google Maps.');
  }
  loadPlaces()
    .then(function (lib) {
      if (!lib || !lib.PlaceAutocompleteElement) throw new Error('no places');
      var pac = new lib.PlaceAutocompleteElement({ includedRegionCodes: ['nz'] });
      pac.className = 'ad-places';
      wrap.insertBefore(pac, address);
      text(note, 'Search above to fill in the address and position, or type them.');
      function fill(place) {
        return place.fetchFields({ fields: ['formattedAddress', 'location', 'displayName'] })
          .then(function () {
            if (place.formattedAddress) address.value = place.formattedAddress;
            if (place.location) pos.value = positionText(place.location.lat(), place.location.lng());
            if (name && !name.value.trim()) {
              name.value = String(place.displayName || place.formattedAddress || '').split(',')[0];
            }
          });
      }
      // 'gmp-select' is the released event; 'gmp-placeselect' the beta's.
      pac.addEventListener('gmp-select', function (ev) {
        if (ev.placePrediction) fill(ev.placePrediction.toPlace()).catch(failed);
      });
      pac.addEventListener('gmp-placeselect', function (ev) {
        if (ev.place) fill(ev.place).catch(failed);
      });
    })
    .catch(failed);
}

/* ------------------------------------------------------------- errors */

// The database refuses by name. Say what that means for the person
// holding the phone; otherwise its own words, without the name.
var MEANINGS = {
  SITE_HAS_BOOKINGS: 'People are booked here on a night still to come, so it stays where it is.',
  REFERENCE_SITE: 'This is the reference site: every price is measured from it, so it stays where it is.',
  SITE_IS_ANCHOR: 'This is its area’s anchor. Make another site the anchor first.',
  ANCHOR_NOT_IN_AREA: 'The anchor must be an active site in that area.',
};
export function explain(err) {
  if (err && err.code && MEANINGS[err.code]) return MEANINGS[err.code];
  var msg = (err && err.message) || 'That did not work.';
  return msg.replace(/^[A-Z_]+:\s*/, '');
}
