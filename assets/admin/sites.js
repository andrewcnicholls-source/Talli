/* Talli Parking — gate screen: sites.js

   The Sites tab: blocks and driveways.
 */

import { button, call, el, make, show, state, text, toast } from './core.js';
import { loadList } from './night.js';

/* ------------------------------------------------------------- sites */

// One driveway at a time: its usual spaces per type, how many of those
// sell online, and its price difference from the reference site.
var SITE_TYPES = [
  { code: 'standard', label: 'Standard' },
  { code: 'priority', label: 'Priority exit' },
  { code: 'valet', label: 'Valet' },
];
var sitesData = { sites: [], blocks: [] };

export function openSites(selectId) {
  call('sites_setup', {})
    .then(function (data) {
      sitesData = data;
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
        opt.textContent = s.name + (s.is_reference ? ' (reference)' : '') +
          (s.active ? '' : ' — inactive');
        group.appendChild(opt);
      });
      var add = document.createElement('option');
      add.value = '__new';
      add.textContent = '+ Add a new site…';
      pick.appendChild(add);
      var exists = data.sites.some(function (s) { return s.property_id === keep; });
      pick.value = exists ? keep : (data.sites[0] ? data.sites[0].property_id : '__new');
      renderSiteForm(pick.value);
    })
    .catch(function (err) { toast(err.message, 'bad'); });
}

function numberInput(value, min) {
  var i = document.createElement('input');
  i.type = 'number';
  i.inputMode = 'numeric';
  i.min = String(min);
  i.step = '1';
  i.className = 'ad-input ad-num';
  i.value = String(value);
  return i;
}

export function renderSiteForm(id) {
  var box = el('ad-site-form');
  box.innerHTML = '';
  if (id === '__new') { renderNewSiteForm(box); return; }
  var site = sitesData.sites.filter(function (s) { return s.property_id === id; })[0];
  if (!site) return;

  box.appendChild(make('p', 'ad-site-meta',
    [site.address, site.block_name ? 'Area: ' + site.block_name + (site.is_anchor ? ' (anchor)' : '') : null,
     site.host_name ? 'Host: ' + site.host_name : null].filter(Boolean).join(' · ')));

  var table = make('div', 'ad-site-grid');
  table.appendChild(make('span', 'ad-site-h', 'Type'));
  table.appendChild(make('span', 'ad-site-h', 'Spaces'));
  table.appendChild(make('span', 'ad-site-h', 'Online'));
  var inputs = {};
  SITE_TYPES.forEach(function (t) {
    var d = (site.defaults || []).filter(function (x) { return x.code === t.code; })[0] || { capacity: 0, online: 0 };
    var cap = numberInput(d.capacity, 0);
    var onl = numberInput(d.online, 0);
    cap.setAttribute('aria-label', t.label + ' spaces');
    onl.setAttribute('aria-label', t.label + ' sold online');
    inputs[t.code] = { cap: cap, onl: onl };
    table.appendChild(make('span', 'ad-site-type', t.label));
    table.appendChild(cap);
    table.appendChild(onl);
  });
  box.appendChild(table);
  box.appendChild(make('p', 'ad-site-help',
    'Online is how many sell on the website; the rest are kept for the warden to sell on the night.'));

  var offsetRow = make('div', 'ad-site-offset');
  var offLabel = make('label', 'ad-label', site.is_reference
    ? 'Price — this is the reference site every other site is priced from'
    : 'Price difference from the reference site ($)');
  offsetRow.appendChild(offLabel);
  var offset = numberInput((site.price_offset_cents || 0) / 100, -100);
  offset.step = '1';
  offset.disabled = site.is_reference;
  offset.setAttribute('aria-label', 'Price difference in dollars');
  offsetRow.appendChild(offset);
  offsetRow.appendChild(make('p', 'ad-site-help',
    site.is_reference ? 'Change prices on Tonight; every other site follows at its own difference.'
      : 'e.g. -5 sells this site at $5 less than the reference site, for every type of space.'));
  box.appendChild(offsetRow);

  var applyRow = make('label', 'ad-site-apply');
  var apply = document.createElement('input');
  apply.type = 'checkbox';
  apply.checked = true;
  applyRow.appendChild(apply);
  applyRow.appendChild(document.createTextNode(
    ' Also update upcoming events this site is in (never below what has sold)'));
  box.appendChild(applyRow);

  var err = make('p', 'ad-sheet-error');
  err.hidden = true;
  box.appendChild(err);

  box.appendChild(button('ad-btn', 'Save site', function () {
    var tiers = [];
    var bad = null;
    SITE_TYPES.forEach(function (t) {
      var c = parseInt(inputs[t.code].cap.value, 10) || 0;
      var o = parseInt(inputs[t.code].onl.value, 10) || 0;
      if (c < 0 || o < 0) bad = 'Counts can’t be negative.';
      if (o > c) bad = t.label + ': online can’t be more than its spaces.';
      tiers.push({ code: t.code, capacity: c, online: o });
    });
    var dollars = Number(offset.value || 0);
    if (!Number.isFinite(dollars) || Math.abs(dollars) > 100) bad = 'Price difference must be between -$100 and $100.';
    if (bad) { text(err, bad); show(err); return; }
    err.hidden = true;
    call('save_site', {
      property_id: site.property_id,
      price_offset_cents: Math.round(dollars * 100),
      tiers: tiers,
      apply_upcoming: apply.checked,
    })
      .then(function (res) {
        var msg = site.name + ' saved';
        if (apply.checked) msg += ' — ' + (res.events_updated || 0) + ' upcoming event' +
          (res.events_updated === 1 ? '' : 's') + ' updated';
        if (res.kept_at_sold) msg += ' (' + res.kept_at_sold + ' kept at what had already sold)';
        toast(msg, 'good');
        openSites(site.property_id);
        if (state.eventId) loadList(true);
      })
      .catch(function (e) { text(err, e.message); show(err); });
  }));
}

// A new driveway: name, address, its area and host, and where it is.
// The position is pasted from Google Maps (long-press a spot, copy the
// two numbers), or a maps.google link with them in it.
function renderNewSiteForm(box) {
  function field(labelText, input) {
    var wrap = make('div', 'ad-site-field');
    wrap.appendChild(make('label', 'ad-label', labelText));
    wrap.appendChild(input);
    box.appendChild(wrap);
    return input;
  }
  function textInput(placeholder) {
    var i = document.createElement('input');
    i.type = 'text';
    i.className = 'ad-input';
    i.placeholder = placeholder || '';
    return i;
  }
  var name = field('Site name', textInput('e.g. 70 Gribblehurst'));
  var address = field('Address', textInput('e.g. 70 Gribblehurst Road, Sandringham, Auckland'));
  var host = field('Host', textInput('Who gets paid for this driveway'));
  var area = document.createElement('select');
  area.className = 'ad-select';
  sitesData.blocks.forEach(function (b) {
    var o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.name;
    area.appendChild(o);
  });
  var newOpt = document.createElement('option');
  newOpt.value = '__new';
  newOpt.textContent = '+ New area…';
  area.appendChild(newOpt);
  field('Area', area);
  var areaName = field('New area name', textInput('e.g. Gribblehurst'));
  var areaWrap = areaName.parentNode;
  areaWrap.hidden = area.value !== '__new';
  area.addEventListener('change', function () { areaWrap.hidden = area.value !== '__new'; });
  var pos = field('Map position', textInput('-36.880692, 174.742279 or a Google Maps link'));

  var err = make('p', 'ad-sheet-error');
  err.hidden = true;
  box.appendChild(err);

  box.appendChild(button('ad-btn', 'Add site', function () {
    var at = parsePosition(pos.value);
    if (pos.value.trim() && !at) { text(err, 'Couldn’t read a position from that.'); show(err); return; }
    err.hidden = true;
    call('create_site', {
      name: name.value.trim(),
      address: address.value.trim(),
      host_name: host.value.trim(),
      block_id: area.value === '__new' ? null : area.value,
      new_block_name: area.value === '__new' ? areaName.value.trim() : null,
      lat: at ? at[0] : null,
      lng: at ? at[1] : null,
    })
      .then(function (res) {
        toast(name.value.trim() + ' added — now set its spaces', 'good');
        openSites(res.property_id);
      })
      .catch(function (e) { text(err, e.message); show(err); });
  }));
}

// "-36.88, 174.74", or any link with "@-36.88,174.74" or "/-36.88,174.74".
function parsePosition(v) {
  var m = String(v || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  var lat = Number(m[1]);
  var lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lat, lng];
}
