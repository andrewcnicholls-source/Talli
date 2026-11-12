/* Talli Parking — gate screen: new-event.js

   The new-event sheet, and saving a pricing template.
 */

import { TZ, button, call, el, hide, make, money, show, state, text, toast } from './core.js';
import { loadList, renderEventOptions } from './night.js';

/* ----------------------------------------------------------- new event */

// A tier as the modal holds it. Everything the database wants, including
// the parts the form does not show — arrival windows, and the zone and
// bay fields older templates still carry — so that editing a template's
// price does not quietly drop the rest of what that template knew.
//
// An arrival window nobody set stays null rather than picking a number
// here. normalise_event_tiers fills it from the tier code — valet and
// priority up to kickoff, standard half an hour before — and the code is
// still being typed when this runs, so the database is the only place
// that can answer. Sending null asks it to.
export function tierDraft(t) {
  t = t || {};
  return {
    code: t.code || '',
    label: t.label || '',
    price_cents: t.price_cents != null ? t.price_cents : 0,
    zone_codes: t.zone_codes || null,
    bay_kind: t.bay_kind || 'any',
    guarantees_clear_exit: !!t.guarantees_clear_exit,
    arrival_from_minutes: t.arrival_from_minutes != null ? t.arrival_from_minutes : null,
    arrival_until_minutes: t.arrival_until_minutes != null ? t.arrival_until_minutes : null,
    departure_by_minutes: t.departure_by_minutes != null ? t.departure_by_minutes : null,
  };
}

export function openNew() {
  el('ad-new-error').hidden = true;
  el('ad-new-form').reset();
  el('ad-new-venue').value = 'Eden Park';
  el('ad-new-gates').value = '150';
  el('ad-new-stop').value = '45';
  el('ad-new-date').value = defaultKickoff();
  state.newTemplate = null;
  state.newTiers = [];
  state.newEndMinutes = 150;
  renderTemplates();
  renderNewTiers();
  show(el('ad-new'));

  // The lists are small and change rarely, but a template saved on another
  // phone ten minutes ago should be there. Fetch every time it opens.
  call('event_form')
    .then(function (data) {
      state.templates = data.templates || [];
      state.properties = data.properties || [];
      state.defaultProperty = data.default_property_id || null;
      renderProperties();
      renderTemplates();
    })
    .catch(function (err) { newError(err.message); });
}

// Saturday evening, a week out — the shape of nearly every fixture, and
// wrong in a way that is obvious rather than subtle if it is not.
function defaultKickoff() {
  var d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(19, 5, 0, 0);
  return [
    d.getFullYear(),
    '-', String(d.getMonth() + 1).padStart(2, '0'),
    '-', String(d.getDate()).padStart(2, '0'),
    'T', String(d.getHours()).padStart(2, '0'),
    ':', String(d.getMinutes()).padStart(2, '0'),
  ].join('');
}

function newError(message) {
  var box = el('ad-new-error');
  text(box, message);
  show(box);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderProperties() {
  var row = el('ad-new-property-row');
  var sel = el('ad-new-property');
  sel.innerHTML = '';
  state.properties.forEach(function (p) {
    sel.appendChild(new Option(p.name, p.id));
  });
  if (state.defaultProperty) sel.value = state.defaultProperty;
  // One property is not a choice. Two is.
  if (state.properties.length > 1) show(row); else hide(row);
}

function renderTemplates() {
  var wrap = el('ad-new-templates');
  wrap.innerHTML = '';

  var blank = make('button', 'ad-pick-opt' + (state.newTemplate ? '' : ' is-on'));
  blank.type = 'button';
  var bl = make('span', 'ad-pick-line');
  bl.appendChild(make('span', 'ad-pick-name', 'Start blank'));
  blank.appendChild(bl);
  blank.appendChild(make('span', 'ad-pick-left', 'type everything yourself'));
  blank.addEventListener('click', function () { applyTemplate(null); });
  wrap.appendChild(blank);

  state.templates.forEach(function (t) {
    var on = state.newTemplate && state.newTemplate.id === t.id;
    var opt = make('button', 'ad-pick-opt' + (on ? ' is-on' : ''));
    opt.type = 'button';

    var line = make('span', 'ad-pick-line');
    line.appendChild(make('span', 'ad-pick-name', t.name));
    var tiers = t.tiers || [];
    if (tiers.length) {
      var cheapest = tiers.reduce(function (lo, x) {
        return lo == null || x.price_cents < lo ? x.price_cents : lo;
      }, null);
      line.appendChild(make('span', 'ad-pick-price', 'from ' + money(cheapest)));
    }
    opt.appendChild(line);
    opt.appendChild(make('span', 'ad-pick-left',
      tiers.length + ' option' + (tiers.length === 1 ? '' : 's') +
      ' · ' + t.venue));

    opt.addEventListener('click', function () { applyTemplate(t); });
    wrap.appendChild(opt);
  });
}

// A template fills the form in; it does not lock it. Everything it wrote
// is an ordinary field afterwards, which is the whole point of having the
// modal rather than a "make one of these" button.
function applyTemplate(t) {
  state.newTemplate = t;

  if (t) {
    if (t.event_name) el('ad-new-name').value = t.event_name;
    el('ad-new-venue').value = t.venue || 'Eden Park';
    el('ad-new-status').value = t.status || 'draft';
    el('ad-new-demand').value = t.demand_tier || 'standard';
    el('ad-new-gates').value = String(Math.abs(t.gates_open_minutes != null
      ? t.gates_open_minutes : -150));
    el('ad-new-stop').value = t.online_close_minutes == null
      ? '' : String(Math.abs(t.online_close_minutes));
    el('ad-new-template-name').value = t.name;
    if (t.property_id) el('ad-new-property').value = t.property_id;
    state.newEndMinutes = t.expected_end_minutes != null ? t.expected_end_minutes : 150;
    state.newTiers = (t.tiers || []).map(tierDraft);
  } else {
    el('ad-new-template-name').value = '';
    state.newEndMinutes = 150;
    state.newTiers = [];
  }

  renderTemplates();
  renderNewTiers();
}

// Rebuilt only when a row is added or removed. Typing updates the draft
// behind the field: re-rendering on every keystroke would take the cursor
// out of whatever is being typed into.
export function renderNewTiers() {
  var wrap = el('ad-new-tiers');
  wrap.innerHTML = '';

  if (!state.newTiers.length) {
    wrap.appendChild(make('p', 'ad-empty',
      'Nothing on sale yet. Pick a template above, or add an option.'));
    return;
  }

  state.newTiers.forEach(function (t, i) {
    var row = make('div', 'ad-tier');

    var top = make('div', 'ad-tier-top');
    var code = make('input', 'ad-input ad-tier-code');
    code.type = 'text';
    code.value = t.code;
    code.placeholder = 'code';
    code.setAttribute('aria-label', 'Tier code');
    code.autocapitalize = 'none';
    code.spellcheck = false;
    code.addEventListener('input', function () { t.code = this.value; });
    top.appendChild(code);

    var drop = button('ad-tier-drop', '×', function () {
      state.newTiers.splice(i, 1);
      renderNewTiers();
    });
    drop.setAttribute('aria-label', 'Remove this option');
    top.appendChild(drop);
    row.appendChild(top);

    var label = make('input', 'ad-input ad-tier-label');
    label.type = 'text';
    label.value = t.label;
    label.placeholder = 'What the customer reads';
    label.setAttribute('aria-label', 'Tier label');
    label.maxLength = 160;
    label.addEventListener('input', function () { t.label = this.value; });
    row.appendChild(label);

    var entry = make('div', 'ad-price-entry');
    entry.appendChild(make('span', null, '$'));
    var price = make('input', 'ad-input');
    price.type = 'number';
    price.inputMode = 'numeric';
    price.min = '1';
    price.max = '500';
    price.step = '1';
    price.value = t.price_cents ? String(Math.round(t.price_cents / 100)) : '';
    price.setAttribute('aria-label', 'Price in dollars');
    price.addEventListener('input', function () {
      var dollars = Number(this.value);
      t.price_cents = isFinite(dollars) ? Math.round(dollars * 100) : 0;
    });
    entry.appendChild(price);
    row.appendChild(entry);

    wrap.appendChild(row);
  });
}

// What the two save buttons both send. The database is the thing that
// validates it — this only catches what it can say something useful about
// without a round trip.
function newPayload(needsDate) {
  var name = el('ad-new-name').value.trim();
  var when = el('ad-new-date').value;
  var gates = Number(el('ad-new-gates').value);
  var closes = el('ad-new-stop').value.trim();

  if (needsDate && !name) throw new Error('The event needs a name.');
  if (needsDate && !when) throw new Error('Pick a kickoff date and time.');
  if (!state.newTiers.length) throw new Error('Add at least one thing to sell.');

  var tiers = state.newTiers.map(function (t, i) {
    var code = String(t.code || '').trim().toLowerCase();
    if (!code) throw new Error('Every option needs a short code — "standard", say.');
    if (!(t.price_cents >= 100 && t.price_cents <= 50000)) {
      throw new Error('Price ' + code + ' between $1 and $500.');
    }
    return {
      code: code,
      label: String(t.label || '').trim() || null,
      price_cents: t.price_cents,
      zone_codes: t.zone_codes,
      bay_kind: t.bay_kind,
      guarantees_clear_exit: t.guarantees_clear_exit,
      arrival_from_minutes: t.arrival_from_minutes,
      arrival_until_minutes: t.arrival_until_minutes,
      departure_by_minutes: t.departure_by_minutes,
      sort_order: i + 1,
    };
  });

  return {
    name: name,
    starts_at_local: when,
    venue: el('ad-new-venue').value.trim() || 'Eden Park',
    status: el('ad-new-status').value,
    demand_tier: el('ad-new-demand').value,
    property_id: state.properties.length > 1
      ? el('ad-new-property').value
      : (state.defaultProperty || null),
    // Typed as "how long before kickoff", stored as a signed offset.
    gates_open_minutes: isFinite(gates) ? -Math.abs(gates) : -150,
    online_close_minutes: closes === '' ? null : -Math.abs(Number(closes)),
    expected_end_minutes: state.newEndMinutes,
    tiers: tiers,
    // The time in the box is a wall clock, not an instant. Send the zone
    // the phone is in so a session run from anywhere else still means
    // 7:05pm at the ground.
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || TZ,
  };
}

export function submitNew(e) {
  e.preventDefault();
  var payload;
  try {
    payload = newPayload(true);
  } catch (err) {
    newError(err.message);
    return;
  }

  var btn = el('ad-new-save');
  btn.disabled = true;
  el('ad-new-error').hidden = true;

  call('create_event', payload)
    .then(function (data) {
      hide(el('ad-new'));
      toast(payload.name + ' created', 'good');
      // Land on the event that was just made, rather than leaving the
      // screen on whatever was selected before it existed.
      return call('events').then(function (list) {
        state.events = list.events || [];
        state.eventId = data.event_id;
        renderEventOptions();
        el('ad-event').value = state.eventId;
        return loadList();
      });
    })
    .catch(function (err) { newError(err.message); })
    .finally(function () { btn.disabled = false; });
}

export function saveTemplate() {
  var payload;
  try {
    // A template deliberately keeps no date, so it does not need one
    // typed before it can be saved.
    payload = newPayload(false);
  } catch (err) {
    newError(err.message);
    return;
  }

  var templateName = el('ad-new-template-name').value.trim();
  if (!templateName) {
    newError('Give the template a name — that is what you pick it from next time.');
    el('ad-new-template-name').focus();
    return;
  }

  var btn = el('ad-new-save-template');
  btn.disabled = true;
  el('ad-new-error').hidden = true;

  // The date is the one thing a template deliberately does not keep.
  payload.template_name = templateName;
  delete payload.starts_at_local;
  delete payload.timezone;

  call('save_template', payload)
    .then(function () {
      toast('Template "' + templateName + '" saved', 'good');
      return call('event_form').then(function (data) {
        state.templates = data.templates || [];
        // Stay on the template just saved, so "save as template" then
        // "save event" is one continuous thing rather than two.
        state.newTemplate = state.templates.filter(function (t) {
          return t.name === templateName;
        })[0] || null;
        renderTemplates();
      });
    })
    .catch(function (err) { newError(err.message); })
    .finally(function () { btn.disabled = false; });
}
