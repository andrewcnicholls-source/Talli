#!/usr/bin/env bash
# =====================================================================
#  Talli — the validation command.
#
#  There is no build and no bundler: the site is static files served
#  as-is. Validation is two things. First, static checks that read the
#  repository. Then the automated suites (plan T0): units, then the
#  database, the edge functions and the browser against a LOCAL Supabase
#  stack built from supabase/migrations/ from empty. Every check below is
#  real. None of them are stubs.
#
#      bash scripts/check.sh            everything
#      bash scripts/check.sh --fast     everything but the browser run
#      bash scripts/check.sh --static   static checks and units only, no
#                                       stack (no Docker needed)
#
#  The stack suites need Docker and `npm ci --prefix tests`. Without them
#  they are reported as SKIPPED, loudly, and never as passed. In CI
#  (CI=true) a skipped suite is a failure.
#
#  Exits 0 if everything passed, 1 if anything failed. CI runs exactly
#  this script, so a green run locally means a green run on the PR.
# =====================================================================
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
. scripts/talli-env.sh

PASS=0
FAIL=0
SKIP=0

MODE=full
for arg in "$@"; do
  case "$arg" in
    --fast)   MODE=fast ;;
    --static) MODE=static ;;
    *) printf 'unknown option: %s (use --fast or --static)\n' "$arg" >&2; exit 2 ;;
  esac
done

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; SKIP=$((SKIP + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------
head "JavaScript syntax"
# ---------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  while IFS= read -r js; do
    if err=$(node --check "$js" 2>&1); then
      pass "$js"
    else
      fail "$js"
      printf '      %s\n' "$err"
    fi
  done < <(git ls-files '*.js' | grep -v '^supabase/functions/')
else
  skip "node not installed — cannot syntax-check JavaScript"
fi

# ---------------------------------------------------------------------
head "Local asset references resolve"
# ---------------------------------------------------------------------
# A static site's most common breakage: a renamed file leaves a page
# pointing at nothing, and it only shows up in a browser.
if command -v python3 >/dev/null 2>&1; then
  out=$(python3 - <<'PY'
import re, sys, os, glob

import json

# Paths a Pages Function answers (functions/, routed by _routes.json) have
# no file on disk; a link to one is fine as long as the route is real.
routes = []
if os.path.exists('_routes.json'):
    routes = json.load(open('_routes.json', encoding='utf-8')).get('include', [])
def routed(target):
    for r in routes:
        if r.endswith('/*') and target.startswith(r[:-1]) and len(target) > len(r) - 1:
            return True
        if target == r:
            return True
    return False

bad = []
pat = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
for page in sorted(glob.glob('*.html')):
    for ref in pat.findall(open(page, encoding='utf-8').read()):
        if re.match(r'^(https?:)?//|^(mailto|tel|data|javascript):|^#', ref, re.I):
            continue
        target = ref.split('?')[0].split('#')[0]
        if not target:
            continue
        if routed(target):
            continue
        if not os.path.exists(target.lstrip('/')):
            bad.append(f"{page} -> {ref}")
for b in bad:
    print(b)
sys.exit(1 if bad else 0)
PY
)
  if [ $? -eq 0 ]; then
    pass "every local src/href in the HTML pages exists on disk"
  else
    fail "broken local references"
    printf '      %s\n' "$out"
  fi
else
  skip "python3 not installed — cannot check asset references"
fi

# ---------------------------------------------------------------------
head "Environment switch is intact"
# ---------------------------------------------------------------------
# assets/talli-config.js is the single thing standing between the test
# site and real customer data. If any of this drifts, a test page can
# start talking to the production database.
CFG="assets/talli-config.js"
if [ ! -f "$CFG" ]; then
  fail "$CFG is missing — the environment switch has no home"
else
  for host in 'talli.co.nz' 'www.talli.co.nz'; do
    if grep -q "'$host'" "$CFG"; then
      pass "production host listed: $host"
    else
      fail "production host missing from PRODUCTION_HOSTS: $host"
    fi
  done

  if grep -q "PRODUCTION_HOSTS.indexOf(host) !== -1 ? PRODUCTION : TEST" "$CFG"; then
    pass "unknown hostnames still default to TEST, not production"
  else
    fail "the hostname switch no longer defaults to TEST — an unrecognised host could reach production data"
  fi

  if grep -q "$TALLI_PRODUCTION_SUPABASE_REF" "$CFG" && grep -q "$TALLI_STAGING_SUPABASE_REF" "$CFG"; then
    pass "both Supabase projects referenced, and they are different projects"
  else
    fail "$CFG does not reference both Supabase project refs"
  fi
fi

# ---------------------------------------------------------------------
head "Events pages choose their database the way the browser does"
# ---------------------------------------------------------------------
# functions/ (plan A2) render on the server, so they cannot use
# assets/talli-config.js and carry their own copy of the switch. Two
# copies drift. If they did, /events on a test host could show production
# events, or talli.co.nz could link its customers to test nights.
# tests/units/event-pages.test.js runs both against a list of hostnames;
# these are the cheap structural guards in front of that.
SITE_FN="functions/_lib/site.js"
if [ ! -f "$SITE_FN" ]; then
  skip "no $SITE_FN — no server-rendered pages"
else
  hosts() { sed -n "/PRODUCTION_HOSTS = \[/,/\];/p" "$1" | grep -o "'[^']*'" | sort | tr '\n' ' '; }
  if [ -n "$(hosts "$CFG")" ] && [ "$(hosts "$CFG")" = "$(hosts "$SITE_FN")" ]; then
    pass "the same production hosts in both: $(hosts "$SITE_FN")"
  else
    fail "PRODUCTION_HOSTS differ: talli-config.js [$(hosts "$CFG")] vs $SITE_FN [$(hosts "$SITE_FN")]"
  fi

  if grep -q "PRODUCTION_HOSTS.indexOf(host) !== -1 ? PRODUCTION : TEST" "$SITE_FN"; then
    pass "an unknown hostname is TEST in the functions too"
  else
    fail "$SITE_FN no longer defaults an unknown hostname to TEST"
  fi

  # Nothing but the hostname may choose: no binding, no header, no query.
  if grep -rnE "context\.env|\benv\.|\{[^}]*\benv\b[^}]*\}|headers\.get\(|searchParams" functions/ >/dev/null; then
    fail "a function reads env, a request header or the query string — the hostname alone picks the project"
    grep -rnE "context\.env|\benv\.|\{[^}]*\benv\b[^}]*\}|headers\.get\(|searchParams" functions/ | sed 's/^/      /'
  else
    pass "the functions take their project from the hostname and nothing else"
  fi

  if grep -q "X-Robots-Tag" "$SITE_FN" && grep -q "project !== PRODUCTION" "$SITE_FN"; then
    pass "function responses off production carry X-Robots-Tag (_headers does not reach them)"
  else
    fail "$SITE_FN no longer marks non-production responses noindex"
  fi

  # _routes.json decides which paths reach a function at all. A route file
  # it does not include is dead; an include with no file is a 404 the
  # static site used to answer.
  if routes_out=$(python3 - <<'PY'
import json, os, re, sys
inc = sorted(json.load(open('_routes.json'))['include'])
found = []
for d, _, files in os.walk('functions'):
    for f in files:
        # Forward slashes on every OS, so the routes compare on Windows too.
        rel = os.path.join(d, f)[len('functions'):].replace(os.sep, '/')
        if '/_' in rel or not f.endswith('.js'):
            continue
        r = rel[:-3]
        r = re.sub(r'/index$', '', r) or '/'
        r = re.sub(r'/\[[^\]/]+\]$', '/*', r)
        found.append(r)
found = sorted(found)
print(' '.join(found))
sys.exit(0 if found == inc else 1)
PY
); then
    pass "_routes.json includes exactly the function routes: $routes_out"
  else
    fail "_routes.json and functions/ disagree (functions give: $routes_out)"
  fi
fi

# ---------------------------------------------------------------------
head "Edge function test-fallbacks are still gated on the test project"
# ---------------------------------------------------------------------
# The IS_TEST blocks fill in test-only defaults. They are safe only
# because they compare the project's own SUPABASE_URL against the test
# ref. Lose that comparison in a merge and the fallbacks become live on
# production.
#
# Every .ts file, not just index.ts: a function split across files (gate-ops,
# plan S0) defines IS_TEST in a shared module. A file that only imports it
# is fine; one that declares it must key it on the project ref.
found_is_test=0
for fn in $(find supabase/functions -name '*.ts' -not -path '*/node_modules/*' | sort); do
  if grep -qE '(const|let|var) IS_TEST\b' "$fn"; then
    found_is_test=1
    label=${fn#supabase/functions/}
    if grep -q "TEST_PROJECT_REF = '$TALLI_STAGING_SUPABASE_REF'" "$fn" \
       && grep -q "IS_TEST = (Deno.env.get('SUPABASE_URL')" "$fn"; then
      pass "$label: IS_TEST keyed on the test project ref"
    else
      fail "$label: declares IS_TEST but not keyed on SUPABASE_URL + $TALLI_STAGING_SUPABASE_REF"
    fi
  elif grep -q 'IS_TEST' "$fn" && ! grep -qE "import \{[^}]*\bIS_TEST\b" "$fn"; then
    found_is_test=1
    fail "${fn#supabase/functions/}: uses IS_TEST without declaring or importing it"
  fi
done
[ "$found_is_test" -eq 1 ] || skip "no edge function uses IS_TEST"

# ---------------------------------------------------------------------
head "Unit tests"
# ---------------------------------------------------------------------
# tests/units: plain node, no network, no browser, no stack. Token
# handling in assets/talli-auth.js lives here (it was scripts/check-auth.js
# until T0): capturing the session off the redirect, refreshing it before
# it dies, dropping it when refused. Each fails quietly — nobody gets in
# on a matchday, or a session outlives its welcome.
if command -v node >/dev/null 2>&1; then
  if out=$(node --test 'tests/units/*.test.js' 2>&1); then
    pass "unit tests ($(printf '%s' "$out" | sed -n 's/^# pass //p') passed)"
  else
    fail "unit tests failed"
    printf '%s\n' "$out" | grep -E '^not ok|^# (pass|fail)' | sed 's/^/      /'
  fi
else
  skip "node not installed — unit tests NOT run"
fi

# ---------------------------------------------------------------------
head "Test sign-in stays on the test site"
# ---------------------------------------------------------------------
# The test site offers "sign in as a test user", by password, so device
# testing can see the gate as a warden. That must never reach
# talli.co.nz. Three guards, any one of which is enough on its own:
# the file returns first thing off the test site, the password call
# refuses off the test site, and production's password provider is off
# (DEPLOYMENT.md § 0c, checked by /release-production).
TU="assets/talli-test-users.js"
if [ -f "$TU" ]; then
  # The first statement after reading the config must be the guard.
  first=$(awk 'seen && NF { print; exit } /var CFG = window.TALLI/ { seen = 1 }' "$TU")
  if printf '%s' "$first" | grep -q 'if (!CFG.isTest) return;'; then
    pass "$TU does nothing off the test site"
  else
    fail "$TU no longer returns first thing off the test site (found: $first)"
  fi
else
  pass "no test-user sign-in file"
fi
if grep -A3 'function signInWithPassword' assets/talli-auth.js | grep -q 'if (!CFG.isTest)'; then
  pass "TalliAuth.signInWithPassword refuses off the test site"
else
  fail "TalliAuth.signInWithPassword has lost its test-site guard"
fi

# The seeded accounts are fixtures. In a migration they would be created
# on production.
seeded=$(grep -oE "[a-z.]+\.test@example\.com" supabase/test-only/seed-test-users.sql | sort -u)
hits=""
for addr in $seeded; do
  f=$(grep -l -F "$addr" supabase/migrations/*.sql 2>/dev/null)
  [ -n "$f" ] && hits="$hits $addr:$f"
done
if grep -q -F "talli-test-only" supabase/migrations/*.sql 2>/dev/null; then
  hits="$hits local-password"
fi
# The local stack's password is published, and opens nothing but a stack
# on the machine running the tests. It must never be built into anything
# served, nor be what seed-test-users.sql gives the hosted test project.
lp=$(git ls-files | grep -vE '^(tests/|supabase/test-only/(local-stack-password|seed-test-users)\.sql$|scripts/check\.sh$)' \
  | xargs grep -l -F "talli-test-only" 2>/dev/null)
if [ -z "$lp" ]; then
  pass "the local stack's test password is in no served file"
else
  fail "the local stack's test password appears in: $lp"
fi
if grep -q "current_setting('talli.test_password'" supabase/test-only/seed-test-users.sql \
   && grep -q "TEST_PASSWORD_REQUIRED" supabase/test-only/seed-test-users.sql \
   && grep -q "LOCAL_PASSWORD_REFUSED" supabase/test-only/seed-test-users.sql; then
  pass "seed-test-users.sql takes its password from the person running it"
else
  fail "seed-test-users.sql no longer insists on a chosen password"
fi
if [ -z "$hits" ]; then
  pass "no seeded test account appears in a migration"
else
  fail "a seeded test account is in a migration:$hits"
fi

# ---------------------------------------------------------------------
head "The gate screen is behind a signed-in host"
# ---------------------------------------------------------------------
# gate-ops and check-setup take money and describe payment configuration.
# What stands between them and the open internet is three lines in each
# file: resolve the bearer token against the auth server, insist on a
# confirmed email, ask the database whether that email is a host.
#
# Each of those is one careless merge from being gone, and losing any one
# of them fails open — the screen keeps working perfectly for whoever is
# signed in, and also for everyone else. Nothing else in this repository
# would notice.
# gate-ops is split by area (plan S0); its checks live in auth.ts, which
# index.ts runs before any handler — asserted further down.
GUARDED_FNS="gate-ops:auth.ts check-setup:index.ts"
for entry in $GUARDED_FNS; do
  name=${entry%%:*}
  fn="supabase/functions/$name/${entry#*:}"
  if [ ! -f "$fn" ]; then
    fail "$name: the function is missing"
    continue
  fi

  # Resolved against the auth server, not decoded. The project's own anon
  # key is a valid JWT signed by the same secret, so anything that merely
  # parsed the token would let the whole internet in.
  if grep -q 'auth.getUser(' "$fn"; then
    pass "$name: the bearer token is resolved by Supabase Auth, not decoded"
  else
    fail "$name: nothing calls auth.getUser — the token is not being verified"
  fi

  # Being signed in is not being a host. This is the call that tells the
  # two apart.
  if grep -q "rpc('host_access_for'" "$fn"; then
    pass "$name: a signed-in identity is still checked against host_user"
  else
    fail "$name: does not call host_access_for — any Google account would get in"
  fi

  # The email is the whole security boundary, and it is only worth
  # anything because it comes out of the auth server. Read it off the
  # request body and a caller can simply claim to be Andrew.
  if grep -q "p_email: email" "$fn" && ! grep -qE "p_email: *String\(body" "$fn"; then
    pass "$name: the email checked is the verified one, not one from the body"
  else
    fail "$name: the email passed to host_access_for does not come from the verified user"
  fi
done

# The shared passphrase was retired, not demoted to a fallback. A second
# door would bring back every problem the first one had: a secret that
# cannot say who took the money and cannot be withdrawn from one person.
# Matched on the env read rather than the name, so the functions can still
# explain in a comment what they used to do.
leftover=$(grep -rl "env.get('GATE_PASSPHRASE')" supabase/functions 2>/dev/null || true)
if [ -z "$leftover" ]; then
  pass "no GATE_PASSPHRASE fallback has come back as a second way in"
else
  fail "GATE_PASSPHRASE is read again — the gate screen has two doors"
  printf '      %s\n' "$leftover"
fi

# The browser must send the host's own access token. It used to send the
# anon key here, which the server would now refuse — silently, as "your
# session has expired", on a phone in the dark.
#
# The anon key IS still the right credential for the public extras
# catalogue further down that file, so this looks for the token and for
# the absence of the passphrase rather than banning the anon key outright.
# The gate screen is ES modules under assets/admin/ (plan S0); every call
# goes through post() in core.js. The passphrase check covers every module.
if grep -q "Authorization: 'Bearer ' + token" assets/admin/core.js \
   && grep -q "AUTH.accessToken()" assets/admin/core.js \
   && ! grep -rq "passphrase" assets/admin/; then
  pass "the gate screen sends the signed-in host's token, not a shared secret"
else
  fail "assets/admin/core.js is not sending the signed-in host's access token"
fi

# gate-ops is split by area (plan S0): auth.ts holds the checks, handlers/
# holds the actions, and index.ts is the one door between them. The split
# is only as safe as that door, so hold it to three things.
GO=supabase/functions/gate-ops
# 1. One entry point. A handler file with its own Deno.serve, or one that
#    is handed the raw request, could answer before anyone is checked.
others=$(grep -l "Deno.serve(" $(find "$GO" -name '*.ts' ! -path "$GO/index.ts") 2>/dev/null || true)
if [ "$(grep -c "^Deno.serve(" "$GO/index.ts")" = "1" ] && [ -z "$others" ] \
   && ! grep -qE "\breq\b|Request" "$GO"/handlers/*.ts; then
  pass "gate-ops: index.ts is the only entry point, and no handler sees the request"
else
  fail "gate-ops: a second Deno.serve, or a handler reading the request directly"
fi
# 2. Order. In index.ts: resolve the caller, refuse the denied, refuse a
#    warden an operator action — and only then call a handler.
order=$(awk '
  /caller = await callerFrom\(req\)/ && !a { a = NR }
  /if \(denied\(caller\)\)/ && !b { b = NR }
  /OPERATOR_ONLY\.has\(action\)/ && !c { c = NR }
  /await handler\(/ && !d { d = NR }
  END { print (a && b && c && d && a < b && b < c && c < d) ? "ok" : "bad" }' "$GO/index.ts")
if [ "$order" = "ok" ]; then
  pass "gate-ops: every handler runs after the caller is resolved, checked and scoped"
else
  fail "gate-ops: index.ts can reach a handler before callerFrom, denied() or OPERATOR_ONLY"
fi
# 3. OPERATOR_ONLY names real actions. A misspelt entry fails open: the
#    action it meant to protect is then open to every warden.
missing=""
for a in $(awk '/^export const OPERATOR_ONLY/,/\]\)/' "$GO/auth.ts" | grep -oE "'[a-z_]+'" | tr -d "'"); do
  grep -q "^  async $a(" "$GO"/handlers/*.ts || missing="$missing $a"
done
if [ -z "$missing" ] && awk '/^export const OPERATOR_ONLY/,/\]\)/' "$GO/auth.ts" | grep -q "'create_event'"; then
  pass "gate-ops: every OPERATOR_ONLY action is a real handler"
else
  fail "gate-ops: OPERATOR_ONLY names actions no handler has:${missing:- (list not found)}"
fi

# Event series (plan A1) are Andrew's: a warden may not rename, regroup
# or re-picture what customers see. And the picture bucket is written by
# gate-ops with the service role only — no storage policy may let a
# browser write to it.
series_ops=$(awk '/^export const OPERATOR_ONLY/,/\]\)/' "$GO/auth.ts")
missing=""
for a in series_list save_series set_event_series upload_picture; do
  printf '%s' "$series_ops" | grep -q "'$a'" || missing="$missing $a"
done
if [ -z "$missing" ]; then
  pass "gate-ops: making and changing event series is Andrew's alone"
else
  fail "gate-ops: a warden may call series actions:$missing"
fi
if grep -l "event-pictures" supabase/migrations/*.sql \
     | xargs grep -qiE "create policy[^;]*on storage\.objects"; then
  fail "a migration opens the event-pictures bucket to writes from a browser"
else
  pass "event pictures are written by gate-ops only, never from a browser"
fi

# RLS on, no policy, is what keeps host_user unreadable if a grant is ever
# added by accident. It is the same treatment host and booking get.
SSO="supabase/migrations/20260908090000_talli_host_sso_access.sql"
if [ ! -f "$SSO" ]; then
  fail "the host sign-in migration is missing: $SSO"
elif grep -q "alter table host_user enable row level security" "$SSO" \
     && grep -q "revoke all on host_user from anon, authenticated" "$SSO"; then
  pass "host_user is RLS-enabled and not granted to anon or authenticated"
else
  fail "$SSO no longer locks host_user down"
fi

# ---------------------------------------------------------------------
head "Stripe returns the customer to a site that talks to this project"
# ---------------------------------------------------------------------
# On 8 September 2026 the first real customer paid on talli.co.nz and was
# returned to the staging site: SITE_URL on the production project had been
# set by hand to the staging address. The confirmation page there reads the
# TEST database, so it could not find the booking they had just paid for.
#
# create-checkout now takes the return address from the Origin the browser
# started checkout from, and falls back to SITE_URL only when that address
# is one this project is allowed to return anyone to. Two things have to
# hold for that to keep working, and each is one careless edit from gone:
#
#   the host lists agree     three files name the production hosts
#   the decision is right    production never returns anyone to a test host
#
# The second is not grepped. The real functions are lifted out of the real
# source and run against a table of cases, so a rewrite that keeps the
# shape but loses the rule fails here rather than at a customer.
if command -v python3 >/dev/null 2>&1; then
  gen=$(mktemp -d)
  results=$(python3 - "$gen" <<'PY'
import io, re, sys

gen = sys.argv[1]
out = []
def ok(m):  out.append('OK ' + m)
def bad(m): out.append('BAD ' + m)

FILES = {
    'assets/talli-config.js': 'the browser environment switch',
    'supabase/functions/create-checkout/index.ts': 'the function that builds the return URL',
    'supabase/functions/check-setup/index.ts': 'the screen that reports it',
}

# --- 1. the three host lists must agree -----------------------------
lists, source = {}, {}
for path, what in FILES.items():
    try:
        text = io.open(path, encoding='utf-8').read()
    except OSError:
        bad('%s is missing — %s' % (path, what))
        continue
    source[path] = text
    m = re.search(r'PRODUCTION_HOSTS\s*=\s*\[(.*?)\]', text, re.S)
    if not m:
        bad('%s no longer declares PRODUCTION_HOSTS — %s' % (path, what))
        continue
    lists[path] = sorted(set(re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))))

if len(lists) == len(FILES):
    distinct = {tuple(v) for v in lists.values()}
    if len(distinct) == 1:
        ok('all three files name the same production hosts: '
           + ', '.join(next(iter(distinct))))
    else:
        bad('the production host lists have drifted apart: '
            + '; '.join('%s = %s' % (p, v) for p, v in lists.items()))

# --- 2. the decision itself -----------------------------------------
cc = source.get('supabase/functions/create-checkout/index.ts', '')

def grab(name):
    i = cc.find('function %s(' % name)
    if i < 0:
        return None
    depth, j, started = 0, i, False
    while j < len(cc):
        if cc[j] == '{':
            depth += 1
            started = True
        elif cc[j] == '}':
            depth -= 1
            if started and depth == 0:
                return cc[i:j + 1]
        j += 1
    return None

bodies = {n: grab(n) for n in ('returnBase', 'siteUrlFor')}
gone = [n for n, b in bodies.items() if not b]
hosts_decl = re.search(r'const PRODUCTION_HOSTS = \[[^\]]*\]', cc)

if gone or not hosts_decl:
    bad('create-checkout no longer defines '
        + ', '.join(gone + ([] if hosts_decl else ['PRODUCTION_HOSTS']))
        + ' — the return address is decided somewhere else now and this check '
          'cannot see it. Re-point the check, or restore the functions.')
else:
    # Node runs the real bodies, so only the type annotations come off.
    def strip_types(js):
        def sig(m):
            name, args = m.group(1), m.group(2)
            args = ', '.join(a.split(':')[0].strip()
                             for a in args.split(',') if a.strip())
            return 'function %s(%s) {' % (name, args)
        js = re.sub(r'function (\w+)\(([^)]*)\)\s*:\s*[^{]+\{', sig, js)
        return re.sub(r'^(\s*let \w+):\s*\w+\s*$', r'\1', js, flags=re.M)

    CASES = r"""

// env, Origin the browser sent, SITE_URL secret, where the customer must land
const cases = [
  // Production. The customer paid real money on the real site.
  ['prod', 'https://talli.co.nz',             '',                                'https://talli.co.nz'],
  ['prod', 'https://www.talli.co.nz',         '',                                'https://www.talli.co.nz'],
  // 8 Sep 2026: the secret pointed at staging. The Origin must override it.
  ['prod', 'https://talli.co.nz',             'https://staging.talli.pages.dev', 'https://talli.co.nz'],
  // No Origin and a wrong secret: the default still has to be production.
  ['prod', '',                                'https://staging.talli.pages.dev', 'https://talli.co.nz'],
  ['prod', '',                                '',                                'https://talli.co.nz'],
  ['prod', '',                                'https://talli.co.nz/',            'https://talli.co.nz'],
  // Nobody gets to nominate their own return address.
  ['prod', 'https://evil.example.com',        '',                                'https://talli.co.nz'],
  ['prod', 'http://talli.co.nz',              '',                                'https://talli.co.nz'],
  // Test. Previews and a local checkout are legitimate here.
  ['test', 'https://staging.talli.pages.dev', '',                                'https://staging.talli.pages.dev'],
  ['test', 'https://abc123.talli.pages.dev',  '',                                'https://abc123.talli.pages.dev'],
  ['test', 'http://localhost:8080',           '',                                'http://localhost:8080'],
  // And the mirror of the original fault: a test booking must never be
  // sent to the live site, where the page would query production for it.
  ['test', 'https://talli.co.nz',             '',                                'https://staging.talli.pages.dev'],
  ['test', '',                                'https://talli.co.nz',             'https://staging.talli.pages.dev'],
  ['test', 'https://evil.example.com',        '',                                'https://staging.talli.pages.dev'],
]

// The functions log to stderr when they reject a SITE_URL, which several of
// these cases do on purpose. Quiet during the run so the output stays the
// verdict rather than the noise.
const quiet = console.error
console.error = () => {}
const failures = []
for (const [env, origin, secret, expected] of cases) {
  IS_TEST = env === 'test'
  DEFAULT_SITE_URL = IS_TEST ? 'https://staging.talli.pages.dev' : 'https://talli.co.nz'
  CONFIGURED_SITE_URL = secret
  const headers = new Headers()
  if (origin) headers.set('Origin', origin)
  const got = siteUrlFor(new Request('https://fn.example/x', { method: 'POST', headers }))
  if (got !== expected) {
    failures.push(`${env}: Origin ${origin || '(none)'} + SITE_URL ${secret || '(unset)'} ` +
                  `returned ${got}, expected ${expected}`)
  }
}
console.error = quiet
if (failures.length) {
  console.log('BAD the return address is decided wrongly: ' + failures.join('; '))
  process.exit(1)
}
console.log('OK production never returns a customer to a test site, and the test project never to the live one (' + cases.length + ' cases)')
"""

    io.open(gen + '/return-address.mjs', 'w', encoding='utf-8').write(
        'let IS_TEST = false\n'
        'let CONFIGURED_SITE_URL = ""\n'
        'let DEFAULT_SITE_URL = ""\n'
        + hosts_decl.group(0) + '\n\n'
        + strip_types(bodies['returnBase']) + '\n\n'
        + strip_types(bodies['siteUrlFor']) + '\n\n'
        + CASES)
    ok('the return-address functions are still where this check can run them')

print('\n'.join(out))
PY
)
  while IFS= read -r line; do
    case "$line" in
      'OK '*)  pass "${line#OK }" ;;
      'BAD '*) fail "${line#BAD }" ;;
    esac
  done <<< "$results"

  if [ -f "$gen/return-address.mjs" ]; then
    if ! command -v node >/dev/null 2>&1; then
      skip "node not installed — the return-address rules are NOT exercised"
    elif err=$(node --check "$gen/return-address.mjs" 2>&1); then
      run=$(node "$gen/return-address.mjs" 2>&1)
      while IFS= read -r line; do
        case "$line" in
          'OK '*)  pass "${line#OK }" ;;
          'BAD '*) fail "${line#BAD }" ;;
          *)       [ -n "$line" ] && printf '      %s\n' "$line" ;;
        esac
      done <<< "$run"
    else
      # Loud on purpose. Skipping quietly here would turn the one check that
      # proves the rule into a check that proves nothing.
      fail "could not run the return-address rules — the extraction needs updating"
      printf '      %s\n' "$err"
    fi
  fi

  rm -rf "$gen"
else
  skip "python3 not installed — cannot check the return address"
fi

# ---------------------------------------------------------------------
head "Production build stays a no-op"
# ---------------------------------------------------------------------
# scripts/build.sh runs on every Cloudflare Pages build, production
# included. It must return immediately on the production branch, or a
# deploy starts rewriting the live site.
#
# This runs the script rather than grepping it. The grep it replaced
# would have kept passing on a script that had stopped working, which
# is the one failure that matters here.
if [ -f scripts/build.sh ]; then
  bt=$(mktemp -d)
  mkdir -p "$bt/scripts"
  cp scripts/build.sh scripts/talli-env.sh "$bt/scripts/"

  CF_PAGES_BRANCH="$TALLI_PRODUCTION_BRANCH" bash "$bt/scripts/build.sh" >/dev/null 2>&1
  if [ -e "$bt/robots.txt" ] || [ -e "$bt/_headers" ]; then
    fail "scripts/build.sh writes files on $TALLI_PRODUCTION_BRANCH — it would modify the live deploy"
  else
    pass "scripts/build.sh writes nothing on $TALLI_PRODUCTION_BRANCH"
  fi

  CF_PAGES_BRANCH="$TALLI_INTEGRATION_BRANCH" bash "$bt/scripts/build.sh" >/dev/null 2>&1
  if [ -s "$bt/robots.txt" ] && [ -s "$bt/_headers" ]; then
    pass "scripts/build.sh writes robots.txt and _headers on $TALLI_INTEGRATION_BRANCH"
  else
    fail "scripts/build.sh no longer writes the noindex rules on $TALLI_INTEGRATION_BRANCH — the test site would be indexable"
  fi

  rm -rf "$bt"
else
  skip "scripts/build.sh not present"
fi

# ---------------------------------------------------------------------
head "Search engines are pointed at the right pages"
# ---------------------------------------------------------------------
# robots.txt and sitemap.xml only help while they agree with the pages
# that actually exist. The failure is silent in both directions: a new
# page nobody added to the sitemap just never gets indexed, and a page
# that gained a noindex but stayed in the sitemap asks Google to crawl
# something it is then told to drop.
#
# Note this checks the PRODUCTION robots.txt — the committed one. The
# test site's is written at deploy time by scripts/build.sh and is
# asserted separately, above.
if command -v python3 >/dev/null 2>&1; then
  results=$(python3 - "$TALLI_PRODUCTION_URL" <<'PY'
import glob, os, re, sys, xml.etree.ElementTree as ET

SITE = sys.argv[1].rstrip('/')
out = []
def ok(m):  out.append('OK ' + m)
def bad(m): out.append('BAD ' + m)

# --- robots.txt -----------------------------------------------------
if not os.path.exists('robots.txt'):
    bad('robots.txt is missing — production ships without one')
else:
    txt = open('robots.txt', encoding='utf-8').read()
    live = [l.strip() for l in txt.splitlines() if l.strip() and not l.lstrip().startswith('#')]
    if any(re.fullmatch(r'(?i)disallow:\s*/', l) for l in live):
        bad('the committed robots.txt blocks the whole site — this is production, it would delist talli.co.nz')
    else:
        ok('the committed robots.txt does not block the live site')
    if f'{SITE}/sitemap.xml' in txt:
        ok('robots.txt points at the sitemap')
    else:
        bad(f'robots.txt does not name {SITE}/sitemap.xml')

# --- which pages are meant to be indexed ----------------------------
# A page is indexable unless it says otherwise. Same default-to-safe
# posture as everywhere else here.
pages, noindex = {}, set()
for p in sorted(glob.glob('*.html')):
    s = open(p, encoding='utf-8').read()
    pages[p] = s
    if re.search(r'<meta\s+name=["\']robots["\'][^>]*noindex', s, re.I):
        noindex.add(p)

# Cloudflare Pages serves foo.html at /foo, and index.html at /.
def page_to_url(p):
    return f'{SITE}/' if p == 'index.html' else f'{SITE}/' + p[:-5]

# --- the sitemap ----------------------------------------------------
# Generated by functions/sitemap.xml.js (plan A2), so a new series is
# listed without a deploy. Its static part is STATIC_PAGES in
# functions/_lib/site.js; that list must be exactly the indexable pages.
import json, subprocess
static = None
if os.path.exists('sitemap.xml'):
    bad('a committed sitemap.xml is back — it would shadow the generated one at /sitemap.xml')
try:
    got = subprocess.run(['node', '-e',
        "import(require('url').pathToFileURL('functions/_lib/site.js').href)"
        ".then(m => console.log(JSON.stringify({pages: m.STATIC_PAGES, site: m.SITE})))"],
        capture_output=True, text=True, check=True).stdout
    data = json.loads(got)
    static, fn_site = data['pages'], data['site']
    if fn_site.rstrip('/') != SITE:
        bad(f'functions/_lib/site.js names the site {fn_site}, not {SITE}')
except Exception as e:
    bad(f'could not read STATIC_PAGES from functions/_lib/site.js: {e}')

if static is not None:
    if len(static) != len(set(static)):
        bad('STATIC_PAGES lists the same page more than once')
    listed = {SITE + p for p in static}
    expected = {page_to_url(p) for p in pages if p not in noindex}

    missing = sorted(expected - listed)
    if missing:
        bad('indexable pages absent from the sitemap (STATIC_PAGES): ' + ', '.join(missing))
    else:
        ok(f'every indexable page is in the sitemap ({len(expected)} of them)')

    forbidden = sorted(listed & {page_to_url(p) for p in noindex})
    if forbidden:
        bad('the sitemap lists noindex pages: ' + ', '.join(forbidden))
    else:
        ok('no noindex page is advertised in the sitemap')

    stray = sorted(u for u in listed if u not in {page_to_url(p) for p in pages})
    if stray:
        bad('the sitemap lists URLs with no page on disk: ' + ', '.join(stray))
    else:
        ok('every static sitemap URL maps to a page in the repository')

    # --- canonical tags -------------------------------------------------
    # www and the apex both serve this site, so without these Google
    # sees two copies of every page and picks one itself.
    wrong = []
    for p in sorted(pages):
        if p in noindex:
            continue
        m = re.search(r'<link[^>]+rel=["\']canonical["\'][^>]*>', pages[p], re.I)
        if not m:
            wrong.append(f'{p} has no canonical')
            continue
        href = re.search(r'href=["\']([^"\']+)["\']', m.group(0), re.I)
        got = href.group(1) if href else ''
        if got != page_to_url(p):
            wrong.append(f'{p} -> {got or "(no href)"}, expected {page_to_url(p)}')
    if wrong:
        bad('canonical tags disagree with the sitemap: ' + '; '.join(wrong))
    else:
        ok('every indexable page has a canonical matching its sitemap URL')

print('\n'.join(out))
PY
)
  while IFS= read -r line; do
    case "$line" in
      'OK '*)  pass "${line#OK }" ;;
      'BAD '*) fail "${line#BAD }" ;;
    esac
  done <<< "$results"
else
  skip "python3 not installed — cannot check robots.txt and sitemap.xml"
fi

# ---------------------------------------------------------------------
head "No secrets committed"
# ---------------------------------------------------------------------
# Stripe keys live in Supabase Edge Function secrets, per project, and
# nowhere else. Anything that looks like one in git is a real incident.
leaks=$(git ls-files -z \
  | xargs -0 grep -nIE 'sk_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|rk_(live|test)_[A-Za-z0-9]{10,}' \
    2>/dev/null)
if [ -z "$leaks" ]; then
  pass "no Stripe secret or webhook signing key in tracked files"
else
  fail "possible Stripe credential committed"
  printf '      %s\n' "$leaks"
fi

svc=$(git ls-files -z | xargs -0 grep -lI 'service_role"' 2>/dev/null \
  | while read -r f; do
      grep -qE 'eyJ[A-Za-z0-9_-]{20,}' "$f" && echo "$f"
    done)
if [ -z "$svc" ]; then
  pass "no Supabase service-role JWT in tracked files"
else
  fail "possible service-role key committed"
  printf '      %s\n' "$svc"
fi

# ---------------------------------------------------------------------
head "Migrations"
# ---------------------------------------------------------------------
if [ -d supabase/migrations ]; then
  badname=$(ls supabase/migrations | grep -vE '^[0-9]{14}_[a-z0-9_]+\.sql$' || true)
  if [ -z "$badname" ]; then
    pass "every migration filename is <14-digit timestamp>_<name>.sql"
  else
    fail "migration filenames that will not sort predictably"
    printf '      %s\n' "$badname"
  fi

  dupes=$(ls supabase/migrations | cut -c1-14 | sort | uniq -d)
  if [ -z "$dupes" ]; then
    pass "no two migrations share a timestamp"
  else
    fail "duplicate migration timestamps — apply order is undefined"
    printf '      %s\n' "$dupes"
  fi

  # test-only SQL resets fixtures and deletes bookings. It must never be
  # somewhere `supabase db push` would pick it up.
  stray=$(grep -rlEi 'TEST — |reset-test-data' supabase/migrations 2>/dev/null || true)
  if [ -z "$stray" ]; then
    pass "no test-only fixture SQL has leaked into supabase/migrations"
  else
    fail "test fixture SQL inside supabase/migrations — this would run against production"
    printf '      %s\n' "$stray"
  fi
else
  skip "no supabase/migrations directory"
fi

# ---------------------------------------------------------------------
head "An event with people attached cannot be deleted"
# ---------------------------------------------------------------------
# Taking a fixture off sale and deleting it are different acts and only
# one is reversible. Three things hold that line, in three different
# files, and each is one careless edit from being gone:
#
#   the migration   refuses the DELETE in the database
#   the hook        makes an agent ask before trying it on production
#   the reset order keeps the rule safe to apply on test as well
#
# None of this can be proven from the repository alone — the database is
# the authority. What can be proven is that the three pieces are still
# written down, which is what stops a rewrite dropping one silently.
GUARD="supabase/migrations/20260902090000_talli_event_deletion_guard.sql"
if [ ! -f "$GUARD" ]; then
  fail "the event deletion guard migration is missing: $GUARD"
else
  if grep -q "create trigger event_deletion_guard" "$GUARD" \
     && grep -q "before delete on event" "$GUARD"; then
    pass "the guard trigger is still defined on event"
  else
    fail "$GUARD no longer creates a BEFORE DELETE trigger on event"
  fi

  if grep -q "event_interest_event_id_fkey" "$GUARD" \
     && grep -q "on delete restrict" "$GUARD"; then
    pass "registered interest still restricts, rather than cascading away"
  else
    fail "$GUARD no longer pins event_interest to ON DELETE RESTRICT"
  fi
fi

# A later migration that sets the interest rows back to CASCADE would undo
# the guard while every check above still passed, so look at all of them.
recascade=$(grep -lE "event_interest.*on delete cascade" supabase/migrations/*.sql 2>/dev/null \
  | grep -v '20260819122426' || true)
if [ -z "$recascade" ]; then
  pass "no later migration re-cascades event_interest"
else
  fail "a migration puts event_interest back on ON DELETE CASCADE"
  printf '      %s\n' "$recascade"
fi

HOOK=".claude/hooks/supabase-permissions.py"
if [ ! -f "$HOOK" ]; then
  skip "no Supabase permission hook in this checkout"
elif grep -q "PROTECTED_TABLES" "$HOOK" \
     && grep -q "DELETE" "$HOOK"; then
  missing=""
  for t in event event_interest booking; do
    grep -qE "\"$t\"" "$HOOK" || missing="$missing $t"
  done
  if [ -z "$missing" ]; then
    pass "the permission hook still asks before deleting bookings or interest on production"
  else
    fail "the permission hook no longer protects:$missing"
  fi
else
  fail "$HOOK has lost its protected-table DELETE rule"
fi

# The rule is data-shaped, not environment-shaped, which is the only
# reason it can be identical on both projects. That holds ONLY while the
# reset clears dependents before it clears events — otherwise wiping the
# test database starts failing on its own guard.
RESET="supabase/test-only/reset-test-data.sql"
if [ ! -f "$RESET" ]; then
  skip "no test reset script in this checkout"
else
  b=$(grep -nm1 "^delete from booking;" "$RESET" | cut -d: -f1)
  i=$(grep -nm1 "^delete from event_interest;" "$RESET" | cut -d: -f1)
  e=$(grep -nm1 "^delete from event " "$RESET" | cut -d: -f1)
  if [ -n "$b" ] && [ -n "$i" ] && [ -n "$e" ] \
     && [ "$b" -lt "$e" ] && [ "$i" -lt "$e" ]; then
    pass "the test reset clears bookings and interest before events"
  else
    fail "the test reset would hit the deletion guard — clear bookings and interest before events"
    printf '      booking:%s interest:%s event:%s\n' "${b:-none}" "${i:-none}" "${e:-none}"
  fi
fi

# ---------------------------------------------------------------------
head "Spaces held for walk-ups are never sold online"
# ---------------------------------------------------------------------
# Andrew's rule, stated plainly: a good share of the night is a decision
# made at the window, with the car in front of you and the neighbours in
# mind. Those spaces are never on the website.
#
# It used to be a property of the yard — the verge zones were flagged
# gate-only and the bay allocator refused to reach them for an online
# sale. There are no bays now, so it is a number instead: gate_reserve,
# per tier, per night. Same rule, said in a way that is true of any car
# park rather than only of 86 Paice Ave.
#
# Three things hold the line and each is one careless edit from gone:
#
#   the sale        hold_booking refuses a non-gate sale into the reserve
#   the online count v_tier_availability subtracts gate_reserve
#   the default     a new night starts with the reserve already set
#
# The database is the authority and cannot be proven from here. What can
# be proven is that all three are still written down.
# Each of these looks at the LAST migration to define the thing, not at a
# migration named here. Naming one is how the checks this replaced went
# quietly green: they kept passing off a file that a later migration had
# already superseded. Filenames start with a timestamp, so lexical order
# is chronological.
latest_defining() { grep -rl "$1" supabase/migrations/*.sql 2>/dev/null | sort | tail -1; }

HOLD_MIG="$(latest_defining 'function hold_booking')"
VIEW_MIG="$(latest_defining 'view v_tier_availability')"
CAP_MIG="$(latest_defining 'function adjust_tier_capacity')"
NORM_MIG="$(latest_defining 'function normalise_event_tiers')"

if [ -n "$HOLD_MIG" ] && grep -q "HELD_FOR_GATE" "$HOLD_MIG" \
   && grep -q "p_channel <> 'gate'" "$HOLD_MIG"; then
  pass "hold_booking still refuses a non-gate sale into the reserve"
else
  fail "hold_booking no longer keeps the walk-up reserve off the website"
  printf '      checked: %s\n' "${HOLD_MIG:-no hold_booking migration found}"
fi

if [ -n "$VIEW_MIG" ] && grep -q -- "- t.gate_reserve" "$VIEW_MIG"; then
  pass "the online count still subtracts the walk-up reserve"
else
  fail "v_tier_availability's online count no longer subtracts gate_reserve"
  printf '      checked: %s\n' "${VIEW_MIG:-no availability migration found}"
fi

# A reserve nobody remembered to set is the same as no reserve at all, so
# the defaults matter as much as the mechanism. These are the numbers
# Andrew gave: 10/16/6 spaces, 6/3/3 of them online.
if [ -n "$NORM_MIG" ] \
   && grep -qE "when 'standard' then 4" "$NORM_MIG" \
   && grep -qE "when 'priority' then 13" "$NORM_MIG" \
   && grep -qE "when 'valet'    then 3" "$NORM_MIG"; then
  pass "a new night starts with the walk-up reserve already set"
else
  fail "normalise_event_tiers no longer gives a new night a walk-up reserve"
  printf '      checked: %s\n' "${NORM_MIG:-no tier-defaults migration found}"
fi

# Taking the count below what is already sold would claim spaces that
# have people attached to them.
if [ -n "$CAP_MIG" ] && grep -q "ALREADY_SOLD" "$CAP_MIG"; then
  pass "the spaces count cannot be dropped below what is already sold"
else
  fail "adjust_tier_capacity no longer refuses to drop below the bookings taken"
  printf '      checked: %s\n' "${CAP_MIG:-no capacity migration found}"
fi

# The count the booking page reads comes from a SECURITY DEFINER function,
# because the view runs as its reader and anon cannot see booking. Everything
# in `public` is an API endpoint, so that function must not live there —
# it would be callable at /rest/v1/rpc/tier_sold by anyone. The migration
# that defines it LAST is the one that decides; earlier ones are history.
TS_MIG="$(latest_defining 'function .*tier_sold(')"
if [ -n "$TS_MIG" ] \
   && grep -q "function private\.tier_sold(" "$TS_MIG" \
   && ! grep -qE "^create (or replace )?function tier_sold\(" "$TS_MIG"; then
  pass "the count function is out of the schema PostgREST serves"
else
  fail "tier_sold is defined in public — a SECURITY DEFINER count with a URL of its own"
  printf '      checked: %s\n' "${TS_MIG:-no tier_sold migration found}"
fi

# ---------------------------------------------------------------------
head "A payment can never land on a bay that is back on sale"
# ---------------------------------------------------------------------
# One rule, two regimes, and it has to hold in both: Stripe must stop
# accepting payment BEFORE the bay goes back on sale. Get the order wrong
# either way and the flow takes money for a space it has already resold —
# a failure nobody sees until two cars turn up for one bay.
#
# Far from kickoff the hold (34 min) simply outlives Stripe's own 30-minute
# expiry, and nothing else is involved. Near kickoff the hold is shorter
# than Stripe's floor, so the pay window (8 min) has to be closed by the
# expire-holds sweep before the hold (10 min) lapses.
#
# The database is the authority and cannot be proven from here. What can be
# proven is that the four numbers still line up, and that something still
# acts on the near-kickoff one.
CHECKOUT_FN="supabase/functions/create-checkout/index.ts"
SWEEP_FN="supabase/functions/expire-holds/index.ts"

# `head` is a section printer in this script, so the first-line pick is
# sed's job here, not head's.
read_const() { grep -oE "const $2 *= *[0-9]+" "$1" 2>/dev/null | grep -oE '[0-9]+$' | sed -n 1p; }

NEAR_PAY="$(read_const "$CHECKOUT_FN" NEAR_PAY_MINUTES)"
NEAR_HOLD="$(read_const "$CHECKOUT_FN" NEAR_HOLD_MINUTES)"
FAR_HOLD="$(read_const "$CHECKOUT_FN" FAR_HOLD_MINUTES)"
FLOOR="$(read_const "$CHECKOUT_FN" STRIPE_FLOOR_MINUTES)"

if [ -n "$NEAR_PAY" ] && [ -n "$NEAR_HOLD" ] && [ "$NEAR_PAY" -lt "$NEAR_HOLD" ]; then
  pass "near kickoff, the pay window ($NEAR_PAY min) closes before the hold ($NEAR_HOLD min)"
else
  fail "near kickoff, the pay window no longer closes before the bay is resold"
  printf '      checked: %s (NEAR_PAY_MINUTES=%s, NEAR_HOLD_MINUTES=%s)\n' \
    "$CHECKOUT_FN" "${NEAR_PAY:-unset}" "${NEAR_HOLD:-unset}"
fi

# Far from kickoff nothing shuts the session off early, so the ONLY thing
# keeping the bay is that the hold outlasts Stripe's floor. Shorten the hold
# past it and the far path breaks silently, with no sweep to catch it.
if [ -n "$FAR_HOLD" ] && [ -n "$FLOOR" ] && [ "$FAR_HOLD" -gt "$FLOOR" ]; then
  pass "far from kickoff, the hold ($FAR_HOLD min) outlasts Stripe's floor ($FLOOR min)"
else
  fail "far from kickoff, the hold no longer outlasts the Stripe session"
  printf '      checked: %s (FAR_HOLD_MINUTES=%s, STRIPE_FLOOR_MINUTES=%s)\n' \
    "$CHECKOUT_FN" "${FAR_HOLD:-unset}" "${FLOOR:-unset}"
fi

# The near-kickoff deadline is only real if something enforces it. Stripe's
# own expiry is half an hour away, so without this function the margin above
# is decoration.
if [ -f "$SWEEP_FN" ] && grep -q "sessions.expire(" "$SWEEP_FN"; then
  pass "something still shuts the Stripe session off at that deadline"
else
  fail "nothing expires the Stripe session — the pay window is unenforced"
  printf '      checked: %s\n' "$SWEEP_FN"
fi

# And the sweep is allowed to be late. That is only survivable because the
# database refuses to confirm a hold whose clock has run out; without it, a
# missed run turns a late payment into an oversell.
CONF_MIG="$(latest_defining 'function confirm_booking')"
if [ -n "$CONF_MIG" ] && grep -q "hold_expires_at > now()" "$CONF_MIG"; then
  pass "a hold that has run out can no longer be confirmed into a sale"
else
  fail "confirm_booking will confirm an expired hold — a missed sweep oversells"
  printf '      checked: %s\n' "${CONF_MIG:-no confirm_booking migration found}"
fi

# ---------------------------------------------------------------------
head "A walk-up opens on cash, and a warden is never offered tap to pay"
# ---------------------------------------------------------------------
# A warden working a block alone has no terminal and no access to Andrew's
# Stripe account. The form opening on tap to pay would have them recording
# card sales nobody took. The screen stops offering it; gate-ops decides.
SELL_FIRST=$(python3 - <<'PY2'
import re
s = open('admin.html', encoding='utf-8').read()
m = re.search(r'<select id="ad-sell-payment"[^>]*>(.*?)</select>', s, re.S)
opts = re.findall(r'<option value="([^"]+)"([^>]*)>', m.group(1)) if m else []
sel = [v for v, a in opts if 'selected' in a]
print((sel[0] if sel else (opts[0][0] if opts else '')))
PY2
)
if [ "$SELL_FIRST" = "cash" ]; then
  pass "the walk-up form opens on cash"
else
  fail "the walk-up form opens on '${SELL_FIRST:-nothing}', not cash"
fi

if grep -q "offerTapToPay(op)" assets/admin/session.js; then
  pass "the gate screen takes tap to pay out of a warden's lists"
else
  fail "applyRole no longer hides tap to pay from a warden"
fi

GATE=supabase/functions/gate-ops/handlers/arrivals.ts
if grep -q "if (!caller.all && body.payment_method === 'tap_to_pay')" "$GATE"; then
  pass "gate-ops refuses a warden's walk-up sold by tap to pay"
else
  fail "gate-ops sells by tap to pay for a warden"
fi
if grep -q "if (!caller.all && method === 'tap_to_pay')" "$GATE"; then
  pass "gate-ops refuses a warden moving a booking onto tap to pay"
else
  fail "gate-ops lets a warden record a booking as tap to pay"
fi

# ---------------------------------------------------------------------
head "A warden works the live night, and only that one"
# ---------------------------------------------------------------------
# Plan B2. gate-ops resolves the live event for every Arrivals action;
# the screen having no picker is not what stops a warden naming another
# night. Losing either check below fails open, as the auth checks would.
IDX=supabase/functions/gate-ops/index.ts
AUTH_TS=supabase/functions/gate-ops/auth.ts
if grep -q "LIVE_SCOPED.has(action) && (!caller.all || !eventId)" "$IDX" \
   && grep -q "code: 'NOT_LIVE_EVENT'" "$IDX" \
   && grep -q "LIVE_SCOPED = new Set(\['list', 'tiers', 'sell'\])" "$AUTH_TS"; then
  pass "gate-ops pins a warden's list, tiers and sell to the live night"
else
  fail "gate-ops no longer pins a warden's Arrivals actions to the live night"
fi
if grep -q "mayTouchBooking(allowed, id, liveId)" "$IDX" \
   && grep -q "if (String(data.event_id) !== liveId) return false" "$AUTH_TS"; then
  pass "a warden touches bookings on the live night only"
else
  fail "a warden can touch a booking on a night that is not live"
fi
if grep -q "'set_live_event'," "$AUTH_TS"; then
  pass "only the operator moves the live night"
else
  fail "set_live_event is not OPERATOR_ONLY"
fi

# ---------------------------------------------------------------------
head "Bank details reach a signed-in host or warden, and nobody else"
# ---------------------------------------------------------------------
# The account walk-ups pay into is shown on the warden's Site info tab.
# It lives in bank_transfer_setting, which the anon key must not read —
# not payment_setting, which the booking page reads with it — and the
# real values are entered at release, never committed.
BANK_MIG="$(grep -l 'create table if not exists bank_transfer_setting' supabase/migrations/*.sql | sed -n 1p)"
if [ -z "$BANK_MIG" ]; then
  fail "no migration creates bank_transfer_setting"
else
  if grep -q 'revoke all on bank_transfer_setting from public, anon, authenticated' "$BANK_MIG" &&
     grep -q 'alter table bank_transfer_setting enable row level security' "$BANK_MIG"; then
    pass "bank_transfer_setting has row level security and no grant to anon or authenticated"
  else
    fail "bank_transfer_setting may be readable with the anon key"
  fi
  if grep -lE '(grant[^;]*on (table )?(public\.)?bank_transfer_setting[^;]*to[^;]*(anon|authenticated)|create policy[^;]*on (public\.)?bank_transfer_setting)' \
       supabase/migrations/*.sql >/dev/null 2>&1; then
    fail "a migration grants or opens bank_transfer_setting to the anon key"
  else
    pass "no migration opens bank_transfer_setting to anon or authenticated"
  fi
fi
if grep -q "account_name\|account_number\|bank_transfer_setting" assets/talli-config.js assets/booking.js; then
  fail "bank details are referenced from a page the public loads"
else
  pass "the public pages never ask for the bank details"
fi
REAL_ACCT=$(git grep -nE '\b[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}\b' -- . ':!scripts/check.sh' \
  | grep -vE '\b00-0000-0000000-00\b' || true)
if [ -z "$REAL_ACCT" ]; then
  pass "no bank account number is committed (only the all-zero test fixture)"
else
  fail "a bank account number is committed — enter it at release instead"
  printf '      %s\n' "$REAL_ACCT"
fi
if grep -q "async bank_details(" supabase/functions/gate-ops/handlers/sites.ts; then
  pass "gate-ops serves the bank details after its sign-in checks"
else
  fail "gate-ops no longer serves the bank details — the Site info tab will be empty"
fi

# ---------------------------------------------------------------------
head "A customer is sent to the block they booked, not to Paice Ave"
# ---------------------------------------------------------------------
# getting-here.html on its own is 86 Paice Ave. The confirmation page and
# email must hand it the booked block, and the page must drop the Paice
# Ave directions if it cannot show that block.
if grep -q "getting-here.html?block=" assets/confirmed.js; then
  pass "the confirmation page links to directions for the booked block"
else
  fail "the confirmation page's directions ignore the booked block"
fi
if grep -q 'getting-here` +' supabase/functions/stripe-webhook/index.ts &&
   grep -q '?block=${encodeURIComponent(String(property.block_id))}' supabase/functions/stripe-webhook/index.ts; then
  pass "the confirmation email links to directions for the booked block"
else
  fail "the confirmation email's directions ignore the booked block"
fi
if grep -q '<script src="assets/getting-here.js">' getting-here.html &&
   grep -q "function noDirections" assets/getting-here.js; then
  pass "getting-here takes a block, and hides Paice Ave when it cannot show it"
else
  fail "getting-here.html no longer handles ?block="
fi

# ---------------------------------------------------------------------
head "Card by QR: the database sets the amount, and a parked car keeps its space"
# ---------------------------------------------------------------------
# A walk-up paying by QR is a car already parked. The amount comes from the
# booking, never the screen; an expired or failed link must leave the
# booking owing, never release it; and only the webhook may mark it paid.
GATE=supabase/functions/gate-ops/handlers/arrivals.ts
HOOK=supabase/functions/stripe-webhook/index.ts
if awk "/async card_link\(/,/async card_status\(/" "$GATE" | grep -q "db.rpc('card_surcharge_cents'" &&
   ! awk "/async card_link\(/,/async card_status\(/" "$GATE" | grep -qE "body\.(amount|price|total)"; then
  pass "card_link prices the QR from the booking, not the request"
else
  fail "card_link takes an amount from the request, or no longer asks the database for the surcharge"
fi
if awk "/case 'checkout.session.expired'/,/release_booking/" "$HOOK" | grep -q "if (isGateQr(obj)) return ok" &&
   awk "/case 'checkout.session.async_payment_failed'/,/release_booking/" "$HOOK" | grep -q "if (isGateQr(obj))"; then
  pass "an expired or failed QR link leaves the walk-up owing, never releases the space"
else
  fail "stripe-webhook can release a parked walk-up's space when its QR link expires or fails"
fi
QR_MIG="$(grep -l 'function confirm_gate_card_payment' supabase/migrations/*.sql | sort | tail -1)"
if [ -n "$QR_MIG" ] && grep -q "from public, anon, authenticated" "$QR_MIG" &&
   grep -q "stripe_checkout_session_id is distinct from p_session_id" "$QR_MIG"; then
  pass "only the webhook can mark a QR payment, and only for the session made for it"
else
  fail "confirm_gate_card_payment is callable from the browser, or not tied to its session"
fi
if grep -q "if (isGateAddress(String(b.customer_email))) return" "$HOOK"; then
  pass "a walk-up's made-up gate+ address is never emailed"
else
  fail "the confirmation email can go to a walk-up's placeholder address"
fi

# ---------------------------------------------------------------------
head "Edge function TypeScript"
# ---------------------------------------------------------------------
# The functions import Stripe from esm.sh and supabase-js from jsr.io, so
# `deno check` needs the network. A sandbox that cannot reach those hosts
# gets an import failure, and reporting that as "does not typecheck" sends
# someone hunting for a type error that is not there. Tell the two apart:
# a failure that never got as far as checking is a skip, not a fail.
if command -v deno >/dev/null 2>&1; then
  if out=$(deno check supabase/functions/*/index.ts 2>&1); then
    pass "edge function TypeScript typechecks"
  elif printf '%s' "$out" | grep -qE "failed to load|Import '|error sending request|unsuccessful tunnel|403 Forbidden"; then
    skip "deno cannot reach esm.sh or jsr.io from here — TypeScript is NOT typechecked"
  else
    fail "edge function TypeScript does not typecheck"
    printf '%s\n' "$out" \
      | grep -E "TS[0-9]+ \[ERROR\]|Found [0-9]+ error" \
      | sed -n '1,20p' | sed 's/^/      /'
  fi
else
  skip "deno not installed — edge function TypeScript is NOT typechecked"
fi

# ---------------------------------------------------------------------
head "Automated suites against a local stack"
# ---------------------------------------------------------------------
# Database (pgTAP), edge functions (node --test over HTTP) and browser
# (Playwright), against `supabase start` on this machine — never the
# shared test project, which is Andrew's device-testing database.
# The database is rebuilt from supabase/migrations/ and the test-only
# fixtures on every run, so a migration that does not replay fails here.
SB="tests/node_modules/.bin/supabase"
# storage-api runs: gate-ops stores event pictures in it (plan A1).
SUITES_EXCLUDE="studio,imgproxy,logflare,vector,supavisor,mailpit,realtime,postgres-meta"

missing() {
  if [ "${CI:-}" = "true" ]; then fail "$1"; else skip "$1"; fi
}

run_stack_suites() {
  if [ ! -x "$SB" ]; then
    missing "tests/node_modules is not installed (npm ci --prefix tests) — database, functions and browser suites NOT run"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    missing "Docker is not running — database, functions and browser suites NOT run"
    return
  fi

  if ! "$SB" status --workdir . >/dev/null 2>&1; then
    printf '      starting the local stack (first run pulls images; minutes)\n'
    if ! out=$("$SB" start --workdir . -x "$SUITES_EXCLUDE" 2>&1); then
      fail "the local stack would not start"
      printf '%s\n' "$out" | tail -15 | sed 's/^/      /'
      return
    fi
  fi

  if out=$("$SB" db reset --workdir . 2>&1); then
    pass "every migration replays from empty, and the fixtures load"
  else
    fail "the database does not rebuild from supabase/migrations/"
    printf '%s\n' "$out" | tail -15 | sed 's/^/      /'
    return
  fi

  # The hosted test project gets a password its owner chooses. Prove the
  # seed refuses to run without one, and refuses the local one.
  seed_says() {
    { printf '%s\n' "$1"; cat supabase/test-only/seed-test-users.sql; } \
      | docker exec -i supabase_db_talli psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q 2>&1
  }
  no_pw=$(seed_says "set talli.test_password = ''; set talli.local_stack = '';")
  local_pw=$(seed_says "set talli.test_password = 'talli-test-only'; set talli.local_stack = '';")
  if printf '%s' "$no_pw" | grep -q TEST_PASSWORD_REQUIRED \
     && printf '%s' "$local_pw" | grep -q LOCAL_PASSWORD_REFUSED; then
    pass "the test-user seed will not run without a chosen password"
  else
    fail "the test-user seed runs with no password, or with the published local one"
  fi

  local envs
  envs=$("$SB" status --workdir . -o env 2>/dev/null)
  eval "$(printf '%s\n' "$envs" | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|FUNCTIONS_URL|JWT_SECRET)=' | sed 's/^/export /')"

  if out=$("$SB" test db --workdir . 2>&1); then
    pass "database suite ($(printf '%s' "$out" | sed -n 's/^Files=[0-9]*, Tests=\([0-9]*\).*/\1/p') assertions)"
  else
    fail "database suite failed"
    printf '%s\n' "$out" | grep -E 'not ok|#   |Failed|Result' | sed 's/^/      /'
  fi

  # After the reset, PostgREST has to reload its picture of the schema
  # before the functions can call into it. Wait until it can see the
  # function every gate request starts with.
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/rest/v1/rpc/host_access_for" \
      -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
      -H 'Content-Type: application/json' -d '{"p_user_id":null,"p_email":""}')
    [ "$code" = "200" ] && break
    sleep 1
  done

  # The edge runtime keeps workers warm; restart it so the functions
  # under test are the files on disk now.
  docker restart supabase_edge_runtime_talli >/dev/null 2>&1 || true
  # And wait for each function to boot, so a cold start is not a failure.
  for fn in supabase/functions/*/; do
    fn=$(basename "$fn")
    for _ in $(seq 1 60); do
      code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$FUNCTIONS_URL/$fn" \
        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY")
      # Any answer from the function itself; 5xx is the runtime still booting.
      case "$code" in 2*|4*) break ;; esac
      sleep 1
    done
  done

  if out=$(node --test --test-concurrency=1 'tests/functions/*.test.js' 2>&1); then
    pass "functions suite ($(printf '%s' "$out" | sed -n 's/^# pass //p') passed)"
  else
    fail "functions suite failed"
    printf '%s\n' "$out" | grep -E '^not ok|^# (pass|fail)|AssertionError|code:' | sed -n 1,30p | sed 's/^/      /'
  fi

  if [ "$MODE" = "fast" ]; then
    skip "browser suite NOT run (--fast)"
    return
  fi
  if out=$(cd tests && npx playwright test 2>&1); then
    pass "browser suite ($(printf '%s' "$out" | sed -n 's/^ *\([0-9]*\) passed.*/\1/p') passed, phone, tablet and desktop)"
  else
    fail "browser suite failed (videos in tests/test-results/)"
    printf '%s\n' "$out" | grep -E '✘|[0-9]+ (failed|flaky|passed)|Error:' | sed -n 1,30p | sed 's/^/      /'
  fi
}

if [ "$MODE" = "static" ]; then
  missing "--static: database, functions and browser suites NOT run"
else
  run_stack_suites
fi

# ---------------------------------------------------------------------
printf '\n\033[1mResult\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mFAILED\033[0m — do not push until these are fixed.\n\n'
  exit 1
fi
printf '\033[32mPASSED\033[0m\n\n'
exit 0
