/* Talli Parking — gate screen: scope.js

   The selector at the top of the gate screen (plan B6): all sites, one
   block, or one site. Every tab draws from what this returns.

   Pure: no DOM, no state, no imports, so the arithmetic can be tested
   in node on its own. The server has already left out everything the
   caller may not see; this only narrows what is left. It is never what
   keeps a warden out of another block.

   A scope is a string, because it is kept in localStorage:
     'all'          every site the caller can see
     'block:<id>'   the sites in one block
     'site:<id>'    one site

   Totals for a scope are counted here from the rows and tiers in it —
   never taken from the server's whole-night summary — so a site's figures,
   added to its neighbours', are the block's to the cent, and the blocks
   add up to all. Each car counts at exactly one site: the one it is at
   (property_id), which before it arrives is the one it was booked at.
 */

export var ALL = 'all';

export function parseScope(value) {
  var v = String(value || '');
  if (v === ALL) return { kind: 'all', id: null };
  var at = v.indexOf(':');
  if (at > 0) {
    var kind = v.slice(0, at);
    var id = v.slice(at + 1);
    if ((kind === 'block' || kind === 'site') && id) return { kind: kind, id: id };
  }
  return null;
}

// The blocks among these sites, in the order the sites came (the server
// sorts them by block), each with its sites. A site with no block stands
// on its own and is not a block.
export function blocksOf(sites) {
  var out = [];
  var seen = {};
  sites.forEach(function (s) {
    if (!s.block_id) return;
    var b = seen[s.block_id];
    if (!b) {
      b = seen[s.block_id] = { id: s.block_id, name: s.block_name || 'Block', sites: [] };
      out.push(b);
    }
    b.sites.push(s);
  });
  return out;
}

// What the selector offers, as a tree flattened into one list: All, then
// each block with its sites under it. canAll is false for a warden who
// does not hold every block — they get no "all", because there is no
// "all" that is theirs.
export function scopeOptions(sites, canAll) {
  var opts = [];
  if (canAll) opts.push({ value: ALL, label: 'All sites', depth: 0 });
  var blocks = blocksOf(sites);
  blocks.forEach(function (b) {
    opts.push({ value: 'block:' + b.id, label: b.name, depth: 0 });
    b.sites.forEach(function (s) {
      opts.push({ value: 'site:' + s.property_id, label: s.name, depth: 1 });
    });
  });
  sites.forEach(function (s) {
    if (!s.block_id) opts.push({ value: 'site:' + s.property_id, label: s.name, depth: 0 });
  });
  return opts;
}

// The scope to use: the one this device chose, if tonight still has it
// to offer; otherwise all, or failing that the first block.
export function resolveScope(saved, sites, canAll) {
  var opts = scopeOptions(sites, canAll);
  if (opts.some(function (o) { return o.value === saved; })) return saved;
  return opts.length ? opts[0].value : (canAll ? ALL : null);
}

// The property ids in a scope, or null for every one.
export function scopeSiteIds(sites, value) {
  var s = parseScope(value);
  if (!s || s.kind === 'all') return null;
  var ids = {};
  sites.forEach(function (x) {
    if (s.kind === 'site' ? x.property_id === s.id : x.block_id === s.id) {
      ids[x.property_id] = true;
    }
  });
  return ids;
}

// The one site this phone is taken to be standing at: the site chosen,
// or the anchor of the block chosen, or with all chosen the first anchor.
// It is what the walk-up form sells at, what Site info shows, and where
// a lost space is recorded unless the sheet says otherwise.
export function hereSite(sites, value) {
  var s = parseScope(value);
  var pool = sites;
  if (s && s.kind === 'site') {
    var one = sites.filter(function (x) { return x.property_id === s.id; })[0];
    if (one) return one;
  }
  if (s && s.kind === 'block') {
    pool = sites.filter(function (x) { return x.block_id === s.id; });
  }
  return pool.filter(function (x) { return x.is_anchor; })[0] || pool[0] || null;
}

// The one site chosen, or null when the scope is wider than a site.
export function chosenSite(sites, value) {
  var s = parseScope(value);
  if (!s || s.kind !== 'site') return null;
  return sites.filter(function (x) { return x.property_id === s.id; })[0] || null;
}

export function scopeLabel(sites, value) {
  var s = parseScope(value);
  if (!s || s.kind === 'all') return 'All sites';
  if (s.kind === 'block') {
    var b = blocksOf(sites).filter(function (x) { return x.id === s.id; })[0];
    return b ? b.name : '';
  }
  var site = chosenSite(sites, value);
  return site ? site.name : '';
}

/* ------------------------------------------------------------ totals */

function rowValue(r) {
  return (r.amount_cents || 0) + (r.addons_cents || 0) + (r.surcharge_cents || 0);
}

function sum(list, f) {
  return list.reduce(function (n, x) { return n + f(x); }, 0);
}

// The night's figures for these rows and tiers. The same definitions as
// nightState() in gate-ops, so with every site in scope the two agree;
// the one difference is that "free" is never negative per type rather
// than per night, which is what makes it add up across sites.
export function summarise(rows, tiers) {
  var paid = rows.filter(function (r) { return r.status === 'paid'; });
  var owes = rows.filter(function (r) { return r.owes; });
  var capacity = sum(tiers, function (t) { return t.capacity || 0; });
  var filled = sum(tiers, function (t) { return t.sold || 0; });
  var lost = sum(tiers, function (t) { return t.lost || 0; });
  return {
    total: rows.length,
    arrived: rows.filter(function (r) { return r.arrived; }).length,
    unpaid_holds: rows.filter(function (r) { return r.in_checkout; }).length,
    owing: owes.length,
    owing_cents: sum(owes, rowValue),
    capacity: capacity,
    filled: filled,
    lost: lost,
    free: sum(tiers, function (t) {
      return Math.max(0, (t.capacity || 0) - (t.sold || 0) - (t.lost || 0));
    }),
    cash_due_cents: sum(rows.filter(function (r) {
      return r.payment_method !== 'stripe' && r.payment_method !== 'unpaid' && !r.arrived;
    }), rowValue),
    taken_cents: sum(paid, rowValue),
    online_cents: sum(paid.filter(function (r) { return r.channel === 'online'; }), rowValue),
    gate_cents: sum(paid.filter(function (r) { return r.channel === 'gate'; }), rowValue),
    addons_cents: sum(paid, function (r) { return r.addons_cents || 0; }),
    surcharge_cents: sum(paid, function (r) { return r.surcharge_cents || 0; }),
    extras_pending: sum(paid, function (r) { return r.addons_pending || 0; }),
  };
}

// What is still in the box, for these rows. As nightState() counts it.
export function extrasOf(rows) {
  var at = {};
  var list = [];
  rows.forEach(function (r) {
    if (r.status !== 'paid') return;
    (r.addons || []).forEach(function (line) {
      var x = at[line.code];
      if (!x) {
        x = at[line.code] = { code: line.code, name: line.name, total: 0, pending: 0 };
        list.push(x);
      }
      x.total += line.qty;
      if (!line.handed) x.pending += line.qty;
    });
  });
  return list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}

// The night narrowed to a scope: { rows, tiers, sites, lost, extras,
// summary }. night is what the `list` action returned (or the screen's
// copy of it); value is a scope string.
export function scopeNight(night, value) {
  var sites = night.sites || [];
  var ids = scopeSiteIds(sites, value);
  var keep = function (x) { return ids === null || ids[x.property_id] === true; };
  var rows = (night.rows || []).filter(keep);
  var tiers = (night.tiers || []).filter(keep);
  return {
    rows: rows,
    tiers: tiers,
    sites: sites.filter(keep),
    lost: (night.lost || []).filter(keep),
    extras: extrasOf(rows),
    summary: summarise(rows, tiers),
  };
}
