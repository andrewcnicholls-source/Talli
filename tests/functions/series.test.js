/* =====================================================================
   Event series through gate-ops (plan A1).

   Andrew makes a series, puts a night in it, and gives it a picture; a
   warden can do none of it. The picture is checked by what the file is,
   not by what the browser says it is, and ends up readable at the public
   bucket address a page will build.
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stack, FIX, gate, rest } = require('../lib/stack');

// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const publicUrl = (path) => `${stack.apiUrl}/storage/v1/object/public/event-pictures/${path}`;

let before;
test.before(async () => {
  before = (await rest(`event?id=eq.${FIX.night}&select=series_id,night_label,picture_path`))[0];
});
// Put the fixture night back where the other suites expect it.
test.after(async () => {
  await rest(`event?id=eq.${FIX.night}`, { method: 'PATCH', body: before });
});

test('a warden is refused every series action', async () => {
  for (const action of ['series_list', 'save_series', 'set_event_series', 'upload_picture']) {
    const r = await gate('wardenGrib', { action, event_id: FIX.night, name: 'TEST — no' });
    assert.equal(r.status, 403, action);
    assert.equal(r.body.code, 'OPERATOR_ONLY', action);
  }
});

test('the operator makes a series, puts a night in it, and gives it a picture', async () => {
  const made = await gate('operator', {
    action: 'save_series', name: 'TEST — Functions series', kind: 'sport', summary: 'From the suite',
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const series = made.body.series;
  assert.equal(series.slug, 'test-functions-series');

  const put = await gate('operator', {
    action: 'set_event_series', event_id: FIX.night, series_id: series.id, night_label: 'v Somebody',
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const list = await gate('operator', { action: 'series_list' });
  const mine = list.body.series.find((s) => s.id === series.id);
  assert.deepEqual(mine.nights.map((n) => n.id), [FIX.night]);
  assert.equal(mine.nights[0].night_label, 'v Somebody');

  const pic = await gate('operator', {
    action: 'upload_picture', target: 'series', id: series.id, content_type: 'image/png', data: PNG,
  });
  assert.equal(pic.status, 200, JSON.stringify(pic.body));
  assert.match(pic.body.picture_path, new RegExp(`^series/${series.id}/[0-9a-f-]+\\.png$`));
  const got = await fetch(publicUrl(pic.body.picture_path));
  assert.equal(got.status, 200);
  assert.match(got.headers.get('content-type') ?? '', /image\/png/);

  // The night list the screen opens with now names the series.
  const session = await gate('operator', { action: 'events' });
  const night = session.body.events.find((e) => e.id === FIX.night);
  assert.equal(night.series.name, 'TEST — Functions series');
  assert.equal(night.night_label, 'v Somebody');
});

test('a picture is judged by its bytes, not its label', async () => {
  const id = before.series_id;
  const lie = await gate('operator', {
    action: 'upload_picture', target: 'series', id, content_type: 'image/png',
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
  });
  assert.equal(lie.status, 400);
  assert.equal(lie.body.code, 'BAD_PICTURE');

  const svg = await gate('operator', {
    action: 'upload_picture', target: 'series', id, content_type: 'image/svg+xml', data: PNG,
  });
  assert.equal(svg.status, 400);
  assert.equal(svg.body.code, 'BAD_PICTURE');
});

test('a night cannot be put in a series that does not exist', async () => {
  const r = await gate('operator', {
    action: 'set_event_series', event_id: FIX.night,
    series_id: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'NO_SUCH_SERIES');
});

test('two series cannot share a name', async () => {
  await gate('operator', { action: 'save_series', name: 'TEST — Twice' });
  const again = await gate('operator', { action: 'save_series', name: 'test — twice' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'SERIES_NAME_TAKEN');
});
