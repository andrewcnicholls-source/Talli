#!/usr/bin/env bash
# =====================================================================
#  Talli — the validation command.
#
#  There is no build, no bundler, no test framework: the site is static
#  files served as-is. So "validation" here means the checks that can
#  actually catch something in a repository shaped like this one, and
#  nothing more. Every check below is real. None of them are stubs.
#
#      bash scripts/check.sh
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

bad = []
pat = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
for page in sorted(glob.glob('*.html')):
    for ref in pat.findall(open(page, encoding='utf-8').read()):
        if re.match(r'^(https?:)?//|^(mailto|tel|data|javascript):|^#', ref, re.I):
            continue
        target = ref.split('?')[0].split('#')[0]
        if not target:
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
head "Edge function test-fallbacks are still gated on the test project"
# ---------------------------------------------------------------------
# The IS_TEST blocks fill in test-only defaults. They are safe only
# because they compare the project's own SUPABASE_URL against the test
# ref. Lose that comparison in a merge and the fallbacks become live on
# production.
found_is_test=0
for fn in supabase/functions/*/index.ts; do
  [ -f "$fn" ] || continue
  if grep -q 'IS_TEST' "$fn"; then
    found_is_test=1
    if grep -q "TEST_PROJECT_REF = '$TALLI_STAGING_SUPABASE_REF'" "$fn" \
       && grep -q "IS_TEST = (Deno.env.get('SUPABASE_URL')" "$fn"; then
      pass "$(basename "$(dirname "$fn")"): IS_TEST keyed on the test project ref"
    else
      fail "$(basename "$(dirname "$fn")"): uses IS_TEST but not keyed on SUPABASE_URL + $TALLI_STAGING_SUPABASE_REF"
    fi
  fi
done
[ "$found_is_test" -eq 1 ] || skip "no edge function uses IS_TEST"

# ---------------------------------------------------------------------
head "Token handling"
# ---------------------------------------------------------------------
# assets/talli-auth.js holds the host's session: capturing it off the
# redirect, refreshing it before it dies, and dropping it when it is
# refused. Every one of those fails quietly — either nobody can get in on
# a matchday, or a session outlives its welcome. scripts/check-auth.js
# runs it against a fake window and a fake fetch. Still no test framework:
# one file, plain node, no dependencies, no network.
if command -v node >/dev/null 2>&1; then
  if out=$(node scripts/check-auth.js 2>&1); then
    pass "assets/talli-auth.js behaves ($(printf '%s' "$out" | grep -c '^  ok') checks)"
  else
    fail "assets/talli-auth.js does not behave"
    printf '%s\n' "$out" | grep 'FAIL' | sed 's/^/      /'
  fi
else
  skip "node not installed — token handling is NOT checked"
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
GUARDED_FNS="gate-ops check-setup"
for name in $GUARDED_FNS; do
  fn="supabase/functions/$name/index.ts"
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
if grep -q "Authorization: 'Bearer ' + token" assets/admin.js \
   && grep -q "AUTH.accessToken()" assets/admin.js \
   && ! grep -q "passphrase" assets/admin.js; then
  pass "the gate screen sends the signed-in host's token, not a shared secret"
else
  fail "assets/admin.js is not sending the signed-in host's access token"
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

if not os.path.exists('sitemap.xml'):
    bad('sitemap.xml is missing')
else:
    try:
        root = ET.parse('sitemap.xml').getroot()
    except ET.ParseError as e:
        bad(f'sitemap.xml is not well-formed XML: {e}')
        root = None
    if root is not None:
        ns = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
        if not root.tag.endswith('urlset'):
            bad('sitemap.xml root element is not <urlset>')
        locs = [e.text.strip() for e in root.findall('s:url/s:loc', ns) if e.text]
        if not locs:
            bad('sitemap.xml lists no URLs — check the xmlns is the sitemaps.org one')
        if len(locs) != len(set(locs)):
            bad('sitemap.xml lists the same URL more than once')

        listed = set(locs)
        expected = {page_to_url(p) for p in pages if p not in noindex}

        missing = sorted(expected - listed)
        if missing:
            bad('indexable pages absent from sitemap.xml: ' + ', '.join(missing))
        else:
            ok(f'every indexable page is in sitemap.xml ({len(expected)} of them)')

        forbidden = sorted(listed & {page_to_url(p) for p in noindex})
        if forbidden:
            bad('sitemap.xml lists noindex pages: ' + ', '.join(forbidden))
        else:
            ok('no noindex page is advertised in sitemap.xml')

        # Every URL must resolve to a file that is really here.
        stray = sorted(u for u in listed if u not in {page_to_url(p) for p in pages})
        if stray:
            bad('sitemap.xml lists URLs with no page on disk: ' + ', '.join(stray))
        else:
            ok('every sitemap URL maps to a page in the repository')

        # --- canonical tags ---------------------------------------------
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
printf '\n\033[1mResult\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mFAILED\033[0m — do not push until these are fixed.\n\n'
  exit 1
fi
printf '\033[32mPASSED\033[0m\n\n'
exit 0
