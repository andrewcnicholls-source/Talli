/* Talli Parking — gate screen: people.js

   People (plan B8), on the Sites page, above Settlement. Andrew's alone:
   every action it calls is operator-only in gate-ops.

     Invite  — an email and the areas they may work. Makes an unclaimed
               invitation; the first Google sign-in with that address
               claims it. Nothing to do in a console.
     Wardens — one card each: signed in yet or not, a switch per area,
               and Deactivate / Reactivate.
     Operators are listed, with nothing to change: they are not made or
               switched off from the screen.

   The screen only offers what the server allows. A warden with every area
   switched off is refused at the gate (NO_BLOCKS); the card says so rather
   than hide it.

   Not narrowed by the selector at the top (plan B6): this is who may open
   the gate screen at all, and a list that hid people would read as
   "nobody else has access".
 */

import { asDate, button, call, el, make, state, text, toast } from './core.js';

var list = null;

var MEANINGS = {
  BAD_EMAIL: 'That is not an email address.',
  NO_BLOCKS_CHOSEN: 'Tick at least one area for the warden.',
  UNKNOWN_BLOCK: 'One of those areas is not on the books any more. Refresh.',
  ALREADY_ON_BOOKS: 'That address is already on the list. Change it from its own card.',
  NOT_A_WARDEN: 'Only a warden’s access is changed here.',
  NO_PERSON: 'That person is not on the books any more. Refresh.',
  NO_OPERATOR_HOST: 'No host is marked as the operator. That needs fixing in the database.',
};
function explain(err) {
  if (err && err.code && MEANINGS[err.code]) return MEANINGS[err.code];
  return String((err && err.message) || 'That did not work.').replace(/^[A-Z_]+:\s*/, '');
}

function box() { return el('ad-people'); }

export function openPeople() {
  if (!state.who || !state.who.operator) { if (box()) box().hidden = true; return; }
  box().hidden = false;
  load();
}

var loadSeq = 0;
function load() {
  var seq = ++loadSeq;
  return call('staff_list', {})
    .then(function (res) { if (seq === loadSeq) { list = res; render(); } })
    .catch(function (err) { toast(explain(err), 'bad'); });
}

/* ------------------------------------------------------------ helpers */

function errorBox(parent) {
  var err = make('p', 'ad-sheet-error');
  err.hidden = true;
  parent.appendChild(err);
  return function (message) {
    if (message) { text(err, message); err.hidden = false; } else { err.hidden = true; }
  };
}

function checkbox(labelText, checked, name) {
  var lab = make('label', 'ad-check');
  var input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  if (name) input.name = name;
  lab.appendChild(input);
  lab.appendChild(make('span', null, labelText));
  return { label: lab, input: input };
}

function seen(p) {
  if (!p.claimed) return 'Invited ' + asDate(p.invited_at) + ' — not signed in yet.';
  if (p.last_seen_at) return 'Signed in. Last seen ' + asDate(p.last_seen_at) + '.';
  return 'Signed in ' + asDate(p.claimed_at) + '.';
}

/* ---------------------------------------------------------- rendering */

function render() {
  var b = box();
  if (!b || !list) return;
  b.innerHTML = '';
  b.appendChild(make('h2', 'ad-site-section', 'People'));
  b.appendChild(make('p', 'ad-site-help',
    'Who may open the gate screen. A warden sees Arrivals and the Site guide for their areas ' +
    'and nothing else. They sign in with Google, using the address you invite.'));

  inviteForm(b);

  var wardens = (list.people || []).filter(function (p) { return p.scope === 'blocks'; });
  var operators = (list.people || []).filter(function (p) { return p.scope !== 'blocks'; });

  b.appendChild(make('h3', 'ad-settle-h', 'Wardens'));
  if (!wardens.length) b.appendChild(make('p', 'ad-site-help', 'No wardens yet.'));
  wardens.forEach(function (p) { b.appendChild(wardenCard(p)); });

  if (operators.length) {
    b.appendChild(make('h3', 'ad-settle-h', 'Operators'));
    b.appendChild(make('p', 'ad-site-help',
      'Everything, every area. Not changed from here.'));
    operators.forEach(function (p) {
      var line = make('p', 'ad-people-op', p.email);
      if (!p.active) line.appendChild(make('span', 'ad-chip is-paused', 'switched off'));
      line.appendChild(make('span', 'ad-site-help', ' ' + seen(p)));
      b.appendChild(line);
    });
  }
}

function inviteForm(parent) {
  var blocks = list.blocks || [];
  var form = make('div', 'ad-settle-block ad-people-invite');
  form.appendChild(make('h3', 'ad-settle-name', 'Invite a warden'));

  var lab = make('label', 'ad-label', 'Their Google email');
  lab.htmlFor = 'ad-people-email';
  form.appendChild(lab);
  var email = document.createElement('input');
  email.type = 'email';
  email.id = 'ad-people-email';
  email.className = 'ad-input';
  email.autocomplete = 'off';
  email.placeholder = 'name@gmail.com';
  form.appendChild(email);

  form.appendChild(make('p', 'ad-label ad-people-areas', 'Areas they may work'));
  var ticks = blocks.map(function (blk) {
    var c = checkbox(blk.name, blocks.length === 1, 'ad-people-new-block');
    c.input.value = blk.id;
    form.appendChild(c.label);
    return c.input;
  });

  var showError = errorBox(form);
  var send = button('btn btn-primary ad-site-save', 'Invite', function () {
    showError(null);
    var chosen = ticks.filter(function (t) { return t.checked; }).map(function (t) { return t.value; });
    send.disabled = true;
    call('invite_warden', { email: email.value, block_ids: chosen })
      .then(function (res) {
        toast(res.email + ' is invited. They sign in with Google to start.', 'good');
        return load();
      })
      .catch(function (err) { showError(explain(err)); })
      .then(function () { send.disabled = false; });
  });
  form.appendChild(send);
  parent.appendChild(form);
}

function wardenCard(p) {
  var card = make('div', 'ad-settle-block ad-people-card' + (p.active ? '' : ' is-off'));
  card.dataset.person = p.host_user_id;
  var name = make('h3', 'ad-settle-name ad-people-email', p.email);
  if (!p.active) name.appendChild(make('span', 'ad-chip is-paused', 'switched off'));
  card.appendChild(name);
  card.appendChild(make('p', 'ad-site-help', seen(p) +
    (p.invited_by ? ' Invited by ' + p.invited_by + '.' : '')));

  // Every area in use, ticked where the warden holds it on; plus any area
  // they still hold that has since been retired, so it can be taken away.
  var held = {};
  (p.blocks || []).forEach(function (g) { held[g.block_id] = g; });
  var areas = (list.blocks || []).map(function (blk) {
    return { id: blk.id, name: blk.name, on: !!(held[blk.id] && held[blk.id].active) };
  });
  (p.blocks || []).forEach(function (g) {
    if (g.active && !areas.some(function (a) { return a.id === g.block_id; })) {
      areas.push({ id: g.block_id, name: g.name + ' (retired)', on: true });
    }
  });

  var showError = errorBox(card);
  var anyOn = areas.some(function (a) { return a.on; });
  if (p.active && !anyOn) {
    card.appendChild(make('p', 'ad-site-help ad-people-warn',
      'Every area is off, so the gate screen turns them away. Tick one to let them back in.'));
  }

  areas.forEach(function (a) {
    var c = checkbox(a.name, a.on);
    c.input.dataset.block = a.id;
    c.input.disabled = !p.active;
    c.input.addEventListener('change', function () {
      showError(null);
      c.input.disabled = true;
      call('set_warden_block', { host_user_id: p.host_user_id, block_id: a.id, on: c.input.checked })
        .then(function () { return load(); })
        .catch(function (err) {
          c.input.checked = !c.input.checked;
          c.input.disabled = false;
          showError(explain(err));
        });
    });
    card.appendChild(c.label);
  });

  var label = p.active ? 'Deactivate' : 'Reactivate';
  var toggle = button('btn ad-people-toggle', label, function () {
    if (p.active && !window.confirm(
      'Deactivate ' + p.email + '? They are turned away from the gate screen straight away. ' +
      'Who they checked in and what cash they took stay on record.')) return;
    showError(null);
    toggle.disabled = true;
    call('set_warden_active', { host_user_id: p.host_user_id, active: !p.active })
      .then(function () {
        toast(p.email + (p.active ? ' is switched off.' : ' is back on.'), 'good');
        return load();
      })
      .catch(function (err) { toggle.disabled = false; showError(explain(err)); });
  });
  card.appendChild(toggle);
  return card;
}
