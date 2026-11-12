/* Talli Parking — gate screen: site-info.js

   The Site info tab: address, directions and bank details for a warden.
 */

import { call, el, hide, make, show, state, text } from './core.js';
import { fatal } from './session.js';
import { currentSite, multiSite } from './night.js';

/* --------------------------------------------------------- site info */

// The bank details come from gate-ops and nowhere else: the anon key
// cannot read them, and they are never in this repository. Fetched the
// first time the tab opens, and again if that failed.
export function openInfo() {
  renderInfo();
  if (state.bank) return;
  call('bank_details', {})
    .then(function (data) {
      state.bank = data;
      state.bankFailed = false;
      renderInfo();
    })
    .catch(function (err) {
      if (fatal(err)) return;
      state.bankFailed = true;
      renderInfo();
    });
}

// What the driver types into the reference field: the location, which is
// the block (the pool a night is settled by), or the site when it has no
// block. Banks in New Zealand take twelve characters there.
function bankReference(site) {
  var where = (site && (site.block_name || site.name)) || '';
  return where.replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 12).trim();
}

export function renderInfo() {
  var pane = el('ad-pane-info');
  if (!pane || pane.hidden) return;
  var site = currentSite() || state.sites[0] || null;

  text(el('ad-info-site'), site
    ? site.name + (site.block_name ? ' · ' + site.block_name : '') +
      (multiSite() ? ' — change site on Arrivals' : '')
    : 'No site selling tonight.');
  text(el('ad-info-address'), site ? (site.address || site.name) : '');

  var maps = el('ad-info-maps');
  maps.innerHTML = '';
  if (site) {
    var to = site.lat != null && site.lng != null
      ? site.lat + ',' + site.lng
      : (site.address || site.name);
    var google = make('a', '', 'Google Maps');
    google.href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(to);
    var apple = make('a', '', 'Apple Maps');
    apple.href = 'https://maps.apple.com/?daddr=' + encodeURIComponent(to);
    [google, apple].forEach(function (a) {
      a.target = '_blank';
      a.rel = 'noopener';
      maps.appendChild(a);
    });
  }

  var bank = state.bank;
  var empty = el('ad-info-bank-empty');
  var list = el('ad-info-bank');
  var ready = bank && bank.account_name && bank.account_number;
  if (!ready) {
    hide(list);
    text(empty, state.bankFailed ? 'Could not load the bank details. Try the tab again.'
      : bank ? 'Bank details are not set up yet. Ask Andrew.'
      : 'Loading…');
    show(empty);
    return;
  }
  hide(empty);
  text(el('ad-info-account-name'), bank.account_name);
  text(el('ad-info-account-number'), bank.account_number);
  text(el('ad-info-reference'), bankReference(site) || '—');
  show(list);
}
