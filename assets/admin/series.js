/* Talli Parking — gate screen: series.js

   The Series & picture sheet (plan A1): which series a night belongs to,
   what the night is called, and the series itself — name, kind, page
   address, summary, picture. Opened from Tonight, so Andrew only; every
   call here is OPERATOR_ONLY in gate-ops, which is what actually decides.

   Pictures go up through gate-ops as base64, never straight to storage:
   no browser holds a key that can write to the bucket.
 */

import { CFG, asDate, call, el, hide, make, show, state, text, toast } from './core.js';
import { renderEventOptions } from './night.js';
import { currentEvent, renderStatus } from './tonight.js';

var NEW = '__new';

// A stored picture is a path in the public bucket; the address is this
// project's, so the same row shows on test and production alike.
export function pictureUrl(path) {
  return path ? CFG.supabaseUrl + '/storage/v1/object/public/event-pictures/' + path : null;
}
var MAX_BYTES = 5 * 1024 * 1024;
var TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// What the open sheet is holding: the series list as loaded, and any
// picture chosen or taken off but not yet saved.
var sheet = {
  list: [],
  pending: { series: null, event: null },
  remove: { series: false, event: false },
};

var PIC = {
  series: { img: 'ad-series-pic', file: 'ad-series-file', remove: 'ad-series-pic-remove' },
  event: { img: 'ad-series-night-pic', file: 'ad-series-night-file',
    remove: 'ad-series-night-pic-remove' },
};

function seriesError(message) {
  var box = el('ad-series-error');
  if (!message) { hide(box); return; }
  text(box, message);
  show(box);
}

// The line under the event's name on Tonight.
export function seriesLine(ev) {
  if (!ev || !ev.series) return '';
  return 'Series: ' + ev.series.name + (ev.night_label ? ' · ' + ev.night_label : '');
}

function chosen() {
  var id = el('ad-series-pick').value;
  return sheet.list.filter(function (s) { return s.id === id; })[0] || null;
}

function renderPick(selectedId) {
  var pick = el('ad-series-pick');
  pick.innerHTML = '';
  sheet.list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
    .forEach(function (s) {
      var o = make('option', '', s.name + (s.active ? '' : ' (not listed)'));
      o.value = s.id;
      pick.appendChild(o);
    });
  var add = make('option', '', '+ New series…');
  add.value = NEW;
  pick.appendChild(add);
  pick.value = selectedId && sheet.list.some(function (s) { return s.id === selectedId; })
    ? selectedId : NEW;
}

function setPic(kind, url) {
  var img = el(PIC[kind].img);
  if (url) {
    img.src = url;
    show(img);
    show(el(PIC[kind].remove));
  } else {
    img.removeAttribute('src');
    hide(img);
    hide(el(PIC[kind].remove));
  }
}

function resetPic(kind) {
  sheet.pending[kind] = null;
  sheet.remove[kind] = false;
  el(PIC[kind].file).value = '';
}

function fillSeries() {
  var s = chosen();
  var ev = currentEvent();
  el('ad-series-name').value = s ? s.name : '';
  el('ad-series-kind').value = s ? s.kind : 'concert';
  el('ad-series-venue').value = s ? s.venue : (ev && ev.venue) || '';
  el('ad-series-summary').value = s ? (s.summary || '') : '';
  el('ad-series-slug').value = s ? s.slug : '';
  el('ad-series-order').value = s ? s.sort_order : 0;
  el('ad-series-active').checked = s ? s.active : true;
  text(el('ad-series-slug-show'), s ? s.slug : '…');
  resetPic('series');
  setPic('series', s ? pictureUrl(s.picture_path) : null);

  var list = el('ad-series-nights');
  list.innerHTML = '';
  var nights = s ? s.nights : [];
  if (!nights.length) {
    list.appendChild(make('li', '', s ? 'No nights yet.' : 'This night will be the first.'));
  }
  nights.forEach(function (n) {
    var li = make('li', ev && n.id === ev.id ? 'is-this' : '',
      asDate(n.starts_at) + ' — ' + (n.night_label || n.name));
    list.appendChild(li);
  });
}

export function openSeries() {
  var ev = currentEvent();
  if (!ev) return;
  seriesError(null);
  text(el('ad-series-event'), ev.name + ' · ' + asDate(ev.starts_at));
  el('ad-series-night').value = ev.night_label || '';
  resetPic('event');
  setPic('event', pictureUrl(ev.picture_path));
  el('ad-series-pick').innerHTML = '<option>Loading…</option>';
  show(el('ad-series'));

  call('series_list')
    .then(function (d) {
      sheet.list = d.series || [];
      renderPick(ev.series_id);
      fillSeries();
    })
    .catch(function (err) { seriesError(err.message); });
}

function pickFile(kind) {
  var input = el(PIC[kind].file);
  var file = input.files && input.files[0];
  if (!file) return;
  if (TYPES.indexOf(file.type) < 0) {
    seriesError('A JPEG, PNG or WebP picture, please.');
    input.value = '';
    return;
  }
  if (file.size > MAX_BYTES) {
    seriesError('Pictures up to 5 MB, please.');
    input.value = '';
    return;
  }
  seriesError(null);
  sheet.pending[kind] = file;
  sheet.remove[kind] = false;
  setPic(kind, URL.createObjectURL(file));
}

function removePic(kind) {
  resetPic(kind);
  sheet.remove[kind] = true;
  setPic(kind, null);
}

function asBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = function () { reject(new Error('Could not read that picture.')); };
    reader.readAsDataURL(file);
  });
}

// One picture change, if there is one to make.
function sendPicture(kind, id) {
  if (sheet.remove[kind]) {
    return call('upload_picture', { target: kind, id: id, remove: true });
  }
  var file = sheet.pending[kind];
  if (!file) return Promise.resolve();
  return asBase64(file).then(function (data) {
    return call('upload_picture', { target: kind, id: id, content_type: file.type, data: data });
  });
}

function submitSeries(e) {
  e.preventDefault();
  var ev = currentEvent();
  if (!ev) return;
  var s = chosen();
  var slug = el('ad-series-slug').value.trim().toLowerCase();
  var payload = {
    series_id: s ? s.id : null,
    name: el('ad-series-name').value.trim(),
    kind: el('ad-series-kind').value,
    venue: el('ad-series-venue').value.trim(),
    summary: el('ad-series-summary').value.trim(),
    sort_order: el('ad-series-order').value,
    active: el('ad-series-active').checked,
  };
  // Only send an address that was typed, so a rename keeps the old one.
  if (slug && (!s || slug !== s.slug)) payload.slug = slug;

  var btn = el('ad-series-save');
  btn.disabled = true;
  seriesError(null);

  call('save_series', payload)
    .then(function (r) {
      var seriesId = r.series.id;
      return call('set_event_series', {
        event_id: ev.id,
        series_id: seriesId,
        night_label: el('ad-series-night').value.trim(),
      }).then(function () { return sendPicture('series', seriesId); })
        .then(function () { return sendPicture('event', ev.id); });
    })
    .then(function () {
      hide(el('ad-series'));
      toast('Saved', 'good');
      return call('events').then(function (list) {
        state.events = list.events || [];
        renderEventOptions();
        el('ad-event').value = state.eventId;
        renderStatus();
      });
    })
    .catch(function (err) { seriesError(err.message); })
    .finally(function () { btn.disabled = false; });
}

export function initSeries() {
  el('ad-series-open').addEventListener('click', openSeries);
  el('ad-series-close').addEventListener('click', function () { hide(el('ad-series')); });
  el('ad-series-pick').addEventListener('change', fillSeries);
  el('ad-series-slug').addEventListener('input', function () {
    text(el('ad-series-slug-show'), this.value.trim().toLowerCase() || '…');
  });
  el('ad-series-form').addEventListener('submit', submitSeries);
  ['series', 'event'].forEach(function (kind) {
    el(PIC[kind].file).addEventListener('change', function () { pickFile(kind); });
    el(PIC[kind].remove).addEventListener('click', function () { removePic(kind); });
  });
}
