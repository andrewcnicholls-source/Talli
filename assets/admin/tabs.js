/* Talli Parking — gate screen: tabs.js

   Switching tabs, and measuring the sticky header.
 */

import { el, state } from './core.js';
import { openInsights } from './insights.js';
import { openInfo } from './site-info.js';
import { openSites } from './sites.js';
import { syncEvent } from './night.js';

// The sticky search bar has to sit directly under the header, whose height
// depends on the safe-area inset and the length of the event name. Measure
// it rather than hard-coding a number that is wrong on half the phones.
// The tier headings then park under the search bar, so measure that too —
// its height moves with the font size the phone is set to.
export function measureHead() {
  var head = el('ad-head') || document.querySelector('.ad-head');
  if (head) {
    document.documentElement.style.setProperty(
      '--ad-head-h', head.offsetHeight + 'px');
  }
  var tools = document.querySelector('#ad-pane-gate .ad-tools');
  if (tools) {
    document.documentElement.style.setProperty(
      '--ad-tools-h', tools.offsetHeight + 'px');
  }
}

/* ---------------------------------------------------------------- tabs */

var TABS = { gate: 'ad-pane-gate', night: 'ad-pane-night', insights: 'ad-pane-insights',
  sites: 'ad-pane-sites', info: 'ad-pane-info' };

export function showTab(which) {
  state.tab = which;
  Object.keys(TABS).forEach(function (name) {
    var on = name === which;
    el(TABS[name]).hidden = !on;
    el('ad-tab-' + name).classList.toggle('is-on', on);
    el('ad-tab-' + name).setAttribute('aria-selected', String(on));
  });
  // Arrivals and Site info work the live night (plan B2) and name it, with
  // nothing to pick. The header picker is Tonight's alone, for opening any
  // night. Insights has its own, and two pickers on one screen is one too
  // many to read at a glance.
  el('ad-event-row').hidden = which !== 'night';
  el('ad-live').hidden = which !== 'gate' && which !== 'info';
  if (which === 'gate' || which === 'info' || which === 'night') syncEvent();
  measureHead();
  if (which === 'insights') openInsights();
  if (which === 'sites') openSites();
  if (which === 'info') openInfo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
