/* =====================================================================
   assets/talli-auth.js — does it do what its comments claim?

   Moved here from scripts/check-auth.js (plan T0). Token handling is the
   one piece of the site whose failures are both silent and expensive: a
   regression either locks everybody out on a matchday or leaves a session
   alive that should have died.

   Fake window, fake localStorage, fake fetch. No network, no browser.

     node --test tests/units/
   ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const vm = require('vm');

function makeWindow(hash) {
  const store = {};
  return {
    TALLI: { supabaseUrl: 'https://proj.supabase.co', anonKey: 'ANON' },
    location: {
      hash: hash || '',
      origin: 'https://staging.talli.pages.dev',
      pathname: '/admin.html',
      search: '',
      href: '',
    },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    _store: store,
  };
}

function run(win, fetchImpl) {
  const src = fs.readFileSync(__dirname + '/../../assets/talli-auth.js', 'utf8');
  const ctx = vm.createContext({
    window: win, URLSearchParams, fetch: fetchImpl, console, Date, Math, JSON,
  });
  vm.runInContext(src, ctx);
  return win.TalliAuth;
}

const ok = (name, cond) => assert.ok(cond, name);

test("the return trip from Google", async () => {
  let win, auth, calls;
  win = makeWindow('#access_token=AAA&refresh_token=RRR&expires_in=3600&token_type=bearer');
  auth = run(win, async () => { throw new Error('should not fetch'); });
  ok('captures the token out of the fragment', auth.hasSession());
  ok('stores it for the next page load', !!win._store['talli.auth.session']);
  ok('reports no landing error', auth.landingError === null);
  ok('hands the token back without refreshing', (await auth.accessToken()) === 'AAA');
});

test("Google said no", async () => {
  let win, auth, calls;
  win = makeWindow('#error=access_denied&error_description=The+user+cancelled');
  auth = run(win, async () => { throw new Error('should not fetch'); });
  ok('reports what Google said', auth.landingError === 'The user cancelled');
  ok('is not signed in after an error', !auth.hasSession());
});

test("a stored session near expiry refreshes", async () => {
  let win, auth, calls;
  win = makeWindow('');
  win._store['talli.auth.session'] = JSON.stringify({
    access_token: 'OLD', refresh_token: 'RRR',
    expires_at: Math.floor(Date.now() / 1000) + 30,   // inside the skew
  });
  calls = 0;
  auth = run(win, async (url, init) => {
    calls++;
    ok('refresh goes to the token endpoint',
      url === 'https://proj.supabase.co/auth/v1/token?grant_type=refresh_token');
    ok('refresh sends the refresh token',
      JSON.parse(init.body).refresh_token === 'RRR');
    ok('refresh identifies the project', init.headers.apikey === 'ANON');
    return { ok: true, json: async () => ({ access_token: 'NEW', refresh_token: 'R2', expires_in: 3600 }) };
  });
  ok('refreshes a token inside the skew window', (await auth.accessToken()) === 'NEW');
  ok('reuses the fresh token without refreshing again', (await auth.accessToken()) === 'NEW');
  ok('refreshed exactly once', calls === 1);
});

test("concurrent callers share one refresh", async () => {
  let win, auth, calls;
  win = makeWindow('');
  win._store['talli.auth.session'] = JSON.stringify({
    access_token: 'OLD', refresh_token: 'RRR', expires_at: Math.floor(Date.now() / 1000) + 5,
  });
  calls = 0;
  auth = run(win, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, json: async () => ({ access_token: 'NEW', expires_in: 3600 }) };
  });
  const three = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
  ok('three concurrent callers cause one refresh', calls === 1);
  ok('all three get the same fresh token', three.every((t) => t === 'NEW'));
  ok('a refresh with no new refresh_token keeps the old one',
    JSON.parse(win._store['talli.auth.session']).refresh_token === 'RRR');
});

test("a revoked refresh token signs the device out", async () => {
  let win, auth, calls;
  win = makeWindow('');
  win._store['talli.auth.session'] = JSON.stringify({
    access_token: 'OLD', refresh_token: 'REVOKED', expires_at: Math.floor(Date.now() / 1000) + 5,
  });
  auth = run(win, async () => ({ ok: false, status: 400, json: async () => ({}) }));
  ok('a refused refresh yields no token', (await auth.accessToken()) === null);
  ok('and clears the stored session', !win._store['talli.auth.session']);
});

test("expired with no refresh token", async () => {
  let win, auth, calls;
  win = makeWindow('');
  win._store['talli.auth.session'] = JSON.stringify({
    access_token: 'OLD', refresh_token: '', expires_at: Math.floor(Date.now() / 1000) - 1,
  });
  auth = run(win, async () => { throw new Error('should not fetch'); });
  ok('an expired session with nothing to refresh with yields null',
    (await auth.accessToken()) === null);
});

test("signed out entirely", async () => {
  let win, auth, calls;
  win = makeWindow('');
  auth = run(win, async () => { throw new Error('should not fetch'); });
  ok('no stored session means no token', (await auth.accessToken()) === null);
  ok('and hasSession says so', !auth.hasSession());
});

test("sign in redirect", async () => {
  let win, auth, calls;
  win = makeWindow('');
  auth = run(win, async () => { throw new Error('should not fetch'); });
  auth.signInWithGoogle();
  ok('sign-in goes to Supabase with provider and redirect',
    win.location.href === 'https://proj.supabase.co/auth/v1/authorize?provider=google' +
      '&redirect_to=https%3A%2F%2Fstaging.talli.pages.dev%2Fadmin.html');

  // The way out for somebody signed in to the wrong Google account.
  auth.signInWithGoogle({ chooseAccount: true });
  ok('choosing an account forces Google to show its picker',
    win.location.href === 'https://proj.supabase.co/auth/v1/authorize?provider=google' +
      '&prompt=select_account' +
      '&redirect_to=https%3A%2F%2Fstaging.talli.pages.dev%2Fadmin.html');
});

test("sign out drops the device session even if the network fails", async () => {
  let win, auth, calls;
  win = makeWindow('#access_token=AAA&refresh_token=RRR&expires_in=3600');
  auth = run(win, async () => { throw new Error('offline'); });
  await auth.signOut();
  ok('sign out clears the device even when the logout call fails',
    !auth.hasSession() && !win._store['talli.auth.session']);
});

test("password sign-in is refused off the test site, before any request", async () => {
  const win = makeWindow('');
  win.TALLI.isTest = false;
  const auth = run(win, async () => { throw new Error('should not fetch'); });
  await assert.rejects(auth.signInWithPassword('operator.test@example.com', 'x'), /test site only/);
  ok('and leaves nobody signed in', !auth.hasSession());
});

test("password sign-in on the test site keeps the session like Google's", async () => {
  const win = makeWindow('');
  win.TALLI.isTest = true;
  let asked = null;
  const auth = run(win, async (url, init) => {
    asked = { url, body: JSON.parse(init.body), apikey: init.headers.apikey };
    return { ok: true, json: async () => ({ access_token: 'PW', refresh_token: 'R', expires_in: 3600 }) };
  });
  await auth.signInWithPassword('warden.test@example.com', 'pw');
  ok('goes to the password grant', asked.url === 'https://proj.supabase.co/auth/v1/token?grant_type=password');
  ok('sends the account', asked.body.email === 'warden.test@example.com' && asked.body.password === 'pw');
  ok('identifies the project', asked.apikey === 'ANON');
  ok('keeps the session where Google\'s goes', JSON.parse(win._store['talli.auth.session']).access_token === 'PW');
  ok('hands it out', (await auth.accessToken()) === 'PW');
});

test("a refused password sign-in says why and keeps nothing", async () => {
  const win = makeWindow('');
  win.TALLI.isTest = true;
  const auth = run(win, async () => ({ ok: false, json: async () => ({ msg: 'Email logins are disabled' }) }));
  await assert.rejects(auth.signInWithPassword('a@example.com', 'pw'), /disabled/);
  ok('nobody signed in', !auth.hasSession());
});
