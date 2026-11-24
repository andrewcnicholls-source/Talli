/* Talli Parking — gate screen: site-info.js

   The Site guide tab: for the site or area chosen at the top, the bank
   details for a walk-up paying by transfer, then the address, the Locate Us
   card (plan A4) to hold up to a driver's window, and last the pictures of
   where to park.

   Only ever sites the server sent: a warden's night carries their own
   blocks' sites and nothing else, so the guide cannot show another's.
 */

import { CFG, call, el, hide, make, show, state, text } from './core.js';
import { fatal } from './session.js';
import { chosenHere, currentSite, multiSite } from './night.js';

/* --------------------------------------------------------- site info */

// The bank details come from gate-ops and nowhere else: the anon key
// cannot read them, and they are never in this repository. Fetched the
// first time the tab opens, and again if that failed.
export function openInfo() {
  renderInfo();
  loadBank(renderInfo);
}

// One fetch shared by the Site info tab and the payment sheets; then()
// redraws whichever asked. Already loaded, nothing is fetched again.
var bankLoading = null;
function loadBank(then) {
  if (state.bank) return;
  if (!bankLoading) {
    bankLoading = call('bank_details', {})
      .then(function (data) {
        state.bank = data;
        state.bankFailed = false;
      })
      .catch(function (err) {
        if (!fatal(err)) state.bankFailed = true;
      })
      .then(function () { bankLoading = null; });
  }
  bankLoading.then(then);
}

// Under "Paid by" on the walk-up and edit sheets: with Bank transfer
// picked, the account to read out at the window, so the warden does not
// have to leave the sheet for the Site info tab. Hidden for anything else.
// prefix is 'ad-sell' or 'ad-edit'; site gives the reference.
export function renderPayBank(prefix, method, site) {
  var box = el(prefix + '-bank');
  if (!box) return;
  if (method !== 'bank_transfer') { hide(box); return; }
  show(box);
  var bank = state.bank;
  var list = el(prefix + '-bank-list');
  var empty = el(prefix + '-bank-empty');
  if (!(bank && bank.account_name && bank.account_number)) {
    hide(list);
    text(empty, state.bankFailed ? 'Could not load the bank details. Pick Bank transfer again.'
      : bank ? 'Bank details are not set up yet. Ask Andrew.'
      : 'Loading…');
    show(empty);
    if (!bank) {
      state.bankFailed = false;
      loadBank(function () {
        var pay = el(prefix + '-payment');
        if (pay && pay.value === 'bank_transfer') renderPayBank(prefix, pay.value, site);
      });
    }
    return;
  }
  hide(empty);
  text(el(prefix + '-bank-name'), bank.account_name);
  text(el(prefix + '-bank-number'), bank.account_number);
  text(el(prefix + '-bank-reference'), bankReference(site) || '—');
  show(list);
}

// What the driver types into the reference field: the location, which is
// the block (the pool a night is settled by), or the site when it has no
// block. Banks in New Zealand take twelve characters there.
function bankReference(site) {
  var where = (site && (site.block_name || site.name)) || '';
  return where.replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 12).trim();
}

/* -------------------------------------------------- the Locate Us card */

// What the card is for: the one site chosen, or with an area (or all)
// chosen, that area — its /go/ page, at its anchor's address. The site
// the phone is taken to be at is that anchor (hereSite in scope.js).
export function cardTarget() {
  var one = chosenHere();
  var site = one || currentSite() || state.sites[0] || null;
  if (!site) return null;
  if (!one && site.block_slug) {
    return { slug: site.block_slug, address: site.address || site.name };
  }
  return site.slug ? { slug: site.slug, address: site.address || site.name } : null;
}

function cardSvg(target) {
  return window.TalliCard ? window.TalliCard.svg(target) : '';
}

function renderCard() {
  var box = el('ad-guide-card');
  var target = cardTarget();
  var key = target ? target.slug + '|' + target.address : '';
  if (!target || !window.TalliCard) {
    hide(box); hide(el('ad-guide-hint'));
    box.innerHTML = '';
    box.dataset.key = '';
    return;
  }
  // Drawing the code is the slow part: only when the place changes.
  if (box.dataset.key !== key) {
    box.innerHTML = cardSvg(target);
    box.dataset.key = key;
  }
  show(box); show(el('ad-guide-hint'));
}

export function openCard() {
  var target = cardTarget();
  if (!target) return;
  var full = el('ad-guide-full');
  full.innerHTML = cardSvg(target);
  show(full);
  document.body.classList.add('ad-guide-open');
}

export function closeCard() {
  var full = el('ad-guide-full');
  hide(full);
  full.innerHTML = '';
  document.body.classList.remove('ad-guide-open');
}

function pictureUrl(path) {
  return CFG.supabaseUrl + '/storage/v1/object/public/site-pictures/' +
    String(path).split('/').map(encodeURIComponent).join('/');
}

function renderPark(site) {
  var box = el('ad-guide-park');
  var pics = el('ad-guide-pics');
  pics.innerHTML = '';
  var list = (site && site.pictures) || [];
  list.forEach(function (p) {
    var fig = make('figure', 'ad-guide-pic');
    var img = make('img');
    img.src = pictureUrl(p.path);
    img.alt = p.caption || 'Where to park';
    img.loading = 'lazy';
    fig.appendChild(img);
    if (p.caption) fig.appendChild(make('figcaption', '', p.caption));
    pics.appendChild(fig);
  });

  var notes = el('ad-guide-notes');
  text(notes, (site && site.fill_notes) || '');
  notes.hidden = !(site && site.fill_notes);

  var link = el('ad-guide-link');
  link.innerHTML = '';
  if (site && site.site_guide_url) {
    var a = make('a', '', 'Open the site guide');
    a.href = site.site_guide_url;
    a.target = '_blank';
    a.rel = 'noopener';
    link.appendChild(a);
  }
  link.hidden = !(site && site.site_guide_url);

  box.hidden = !(list.length || (site && (site.fill_notes || site.site_guide_url)));
}

export function renderInfo() {
  var pane = el('ad-pane-info');
  if (!pane || pane.hidden) return;
  var site = currentSite() || state.sites[0] || null;
  renderCard();
  renderPark(site);

  text(el('ad-info-site'), site
    ? site.name + (site.block_name ? ' · ' + site.block_name : '') +
      (multiSite() ? ' — change site at the top' : '')
    : 'No site selling tonight.');
  text(el('ad-info-address'), site ? (site.address || site.name) : '');

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
