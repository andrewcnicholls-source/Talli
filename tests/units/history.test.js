/* =====================================================================
   assets/admin/history.js — a booking's history, as the edit sheet
   shows it (20261130100000_talli_booking_history).

   The database writes one line per thing that happened. A gate sale is
   three of them (made, paid, checked in) in one moment; the screen shows
   that as one entry, because to the person reading it it was one thing.

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = path.join(__dirname, '..', '..', 'assets', 'admin', 'history.js');

let historyEntries;
test.before(async () => {
  globalThis.window = { TALLI: { supabaseUrl: 'https://proj.supabase.co' }, TalliAuth: {} };
  ({ historyEntries } = await import(pathToFileURL(FILE).href));
});
test.after(() => { delete globalThis.window; });

const AT = '2026-11-22T06:42:00Z'; // Sat 7:42pm in Auckland
const LATER = '2026-11-22T06:51:00Z';
const line = (kind, extra = {}) => ({ at: AT, kind, before: null, after: null,
  by_name: 'Max', by_label: null, ...extra });

test('a gate sale is one entry: made, how it was paid, checked in', () => {
  const out = historyEntries([
    line('created', { after: { channel: 'gate', payment_method: 'cash' } }),
    line('paid', { after: { status: 'paid', payment_method: 'cash' } }),
    line('checked_in'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].who, 'Max');
  assert.equal(out[0].text, 'Added at the gate · Cash · checked in');
  assert.match(out[0].when, /7:42pm/);
});

test('marking an unpaid walk-up paid by bank transfer says so once', () => {
  const out = historyEntries([
    line('payment', { at: LATER,
      before: { payment_method: 'unpaid', status: 'held' },
      after: { payment_method: 'bank_transfer', status: 'paid' } }),
    line('paid', { at: LATER, after: { status: 'paid', payment_method: 'bank_transfer' } }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Payment: Not paid yet → Bank transfer');
});

test('an online booking was made by the customer', () => {
  const out = historyEntries([
    line('created', { by_name: null, by_label: 'Customer online',
      after: { channel: 'online', payment_method: 'stripe' } }),
  ]);
  assert.equal(out[0].who, 'Customer online');
  assert.match(out[0].text, /^Booked online/);
});

test('nobody recorded is said plainly, not guessed', () => {
  const out = historyEntries([
    line('created', { by_name: null, by_label: null, after: { channel: 'gate', payment_method: 'cash' } }),
  ]);
  assert.equal(out[0].who, 'Not recorded');
});

test('oldest first, one entry per moment', () => {
  const out = historyEntries([
    line('details', { at: LATER, before: { rego: 'A1', phone: null, name: 'J' },
      after: { rego: 'B2', phone: '021', name: 'J' } }),
    line('created', { after: { channel: 'gate', payment_method: 'unpaid' } }),
  ]);
  assert.deepEqual(out.map((e) => e.text),
    ['Added at the gate · Not paid yet', 'Changed rego, phone']);
});

test('a move names the site when the screen knows it', () => {
  const out = historyEntries([
    line('moved', { before: { property_id: 'a' }, after: { property_id: 'b' } }),
  ], (id) => (id === 'b' ? '72 Gribblehurst' : null));
  assert.equal(out[0].text, 'Moved to 72 Gribblehurst');
});

test('the endings read as words', () => {
  const t = (kind) => historyEntries([line(kind)])[0].text;
  assert.equal(t('cancelled'), 'Cancelled');
  assert.equal(t('expired'), 'Hold ran out');
  assert.equal(t('refunded'), 'Refunded');
  assert.equal(t('checked_in'), 'Checked in');
});
