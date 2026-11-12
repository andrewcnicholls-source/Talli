/* Talli Parking — gate screen: check.js

   The configuration check sheet.
 */

import { CFG, el, make, post, text } from './core.js';

/* ------------------------------------------------- configuration check */

// Answers "did I set the keys up right" without anyone spending money to
// find out. The function does the real work; this just renders the verdict.
export function openCheck() {
  var sheet = el('ad-check');
  var list = el('ad-check-list');
  list.innerHTML = '';
  text(el('ad-check-summary'), 'Checking…');
  el('ad-check-summary').className = 'ad-check-summary';
  sheet.hidden = false;

  post(CFG.supabaseUrl + '/functions/v1/check-setup', {})
    .then(function (d) {
      var sum = el('ad-check-summary');
      text(sum, d.summary);
      sum.className = 'ad-check-summary ' + (d.ready ? 'is-good' : 'is-bad');

      (d.checks || []).forEach(function (c) {
        var row = make('div', 'ad-check-row');
        var mark = make('span', 'ad-check-mark ' +
          (c.ok === true ? 'is-good' : c.ok === false ? 'is-bad' : 'is-unknown'),
          c.ok === true ? '✓' : c.ok === false ? '✕' : '?');
        var body = make('span', 'ad-check-body');
        body.appendChild(make('span', 'ad-check-name', c.name));
        body.appendChild(make('span', 'ad-check-detail', c.detail));
        row.appendChild(mark);
        row.appendChild(body);
        list.appendChild(row);
      });
    })
    .catch(function (err) {
      var sum = el('ad-check-summary');
      text(sum, err.message);
      sum.className = 'ad-check-summary is-bad';
    });
}
