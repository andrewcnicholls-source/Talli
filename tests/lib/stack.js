/* =====================================================================
   The local Supabase stack, as the suites see it.

   Everything here talks to the stack `supabase start` runs from this
   repository — never to talli-test or production. The addresses and keys
   come from `supabase status`, which only ever describes the local stack;
   scripts/check.sh exports them before the suites run, and this file asks
   for them itself when a suite is run on its own.
   ===================================================================== */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

function readStatus() {
  const bin = process.env.SUPABASE_BIN ||
    path.join(ROOT, 'tests', 'node_modules', '.bin', 'supabase');
  const out = execFileSync(bin, ['status', '-o', 'env', '--workdir', ROOT],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = process.env.API_URL && process.env.ANON_KEY && process.env.SERVICE_ROLE_KEY
  ? process.env
  : readStatus();

const API_URL = env.API_URL;
// Refuse anything that is not this machine. A suite pointed at a hosted
// project would write invented bookings into Andrew's test database, or
// worse.
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_URL || '')) {
  throw new Error(`The suites run against the local stack only, not ${API_URL}`);
}

const stack = {
  apiUrl: API_URL,
  functionsUrl: env.FUNCTIONS_URL || `${API_URL}/functions/v1`,
  anonKey: env.ANON_KEY,
  serviceKey: env.SERVICE_ROLE_KEY,
  jwtSecret: env.JWT_SECRET,
};

// The LOCAL STACK's password, from supabase/test-only/local-stack-password.sql.
// It opens nothing anywhere else: the test project's accounts have a
// password Andrew chose, which is in no file (DEPLOYMENT.md § 0c).
const PASSWORD = 'talli-test-only';
const USERS = {
  operator: 'operator.test@example.com',
  wardenGrib: 'warden.test@example.com',
  wardenPaice: 'warden.paice.test@example.com',
  wardenNoGrants: 'warden.nogrants.test@example.com',
  outsider: 'outsider.test@example.com',
};

// From supabase/test-only/seed-test-nights.sql.
const FIX = {
  night: '7e57e000-0000-4000-8000-000000000001',
  soldOutNight: '7e57e000-0000-4000-8000-000000000002',
  paice: '22222222-2222-2222-2222-222222222222',
  berm: '22222222-2222-2222-2222-222222222223',
  gribAnchor: '22222222-2222-2222-2222-2222222222a1',
  gribNeighbour: '22222222-2222-2222-2222-2222222222a2',
};

const sessions = new Map();
async function signIn(email) {
  if (sessions.has(email)) return sessions.get(email);
  const res = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`could not sign in as ${email}: ${JSON.stringify(body)}`);
  }
  sessions.set(email, body);
  return body;
}

async function token(who) {
  return (await signIn(USERS[who] || who)).access_token;
}

// An edge function, as a browser calls it: the anon key as apikey, and
// whatever bearer the caller holds.
async function callFn(name, body, bearer, extraHeaders = {}) {
  const res = await fetch(`${stack.functionsUrl}/${name}`, {
    method: 'POST',
    headers: {
      apikey: stack.anonKey,
      Authorization: `Bearer ${bearer ?? stack.anonKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const gate = async (who, body) => callFn('gate-ops', body, await token(who));

// PostgREST under the service role: the suites' way of arranging and
// inspecting the database, never a path the site itself uses.
async function rest(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${API_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: stack.serviceKey,
      Authorization: `Bearer ${stack.serviceKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${pathAndQuery}: ${res.status} ${text}`);
  return json;
}

const rpc = (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: args });

// Something unique enough to find a test's own rows again.
const plate = (prefix = 'T') =>
  (prefix + crypto.randomBytes(3).toString('hex')).toUpperCase().slice(0, 8);

// Throw away bookings a test made, by plate. Test data on a local stack.
async function forget(plates) {
  if (!plates.length) return;
  await rest(`booking?vehicle_rego=in.(${plates.join(',')})`, { method: 'DELETE' });
}

// A JWT HS256-signed with the local stack's secret. Valid as a token; it
// names a user the auth server has never heard of.
function forgeToken(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims,
  });
  const sig = crypto.createHmac('sha256', stack.jwtSecret)
    .update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

module.exports = {
  ROOT, stack, PASSWORD, USERS, FIX,
  signIn, token, callFn, gate, rest, rpc, plate, forget, forgeToken,
};
