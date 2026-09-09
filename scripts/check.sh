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
