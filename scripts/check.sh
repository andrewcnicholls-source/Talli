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
  for host in 'talli.co.nz' 'www.talli.co.nz' 'talliconz.netlify.app'; do
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
head "Production build stays a no-op"
# ---------------------------------------------------------------------
# netlify.toml is read from whichever branch is building, production
# included. build.sh must keep returning immediately unless it is the
# test project, or a deploy starts rewriting the live site.
if [ -f netlify/build.sh ]; then
  if grep -q 'SITE_NAME:-}" != "'"$TALLI_STAGING_SITE_NAME"'"' netlify/build.sh \
     && grep -q 'exit 0' netlify/build.sh; then
    pass "netlify/build.sh still exits early unless SITE_NAME=$TALLI_STAGING_SITE_NAME"
  else
    fail "netlify/build.sh no longer short-circuits on production — it would modify the live deploy"
  fi
else
  skip "netlify/build.sh not present"
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
head "Unavailable in this environment"
# ---------------------------------------------------------------------
command -v deno >/dev/null 2>&1 \
  && { deno check supabase/functions/*/index.ts >/dev/null 2>&1 \
       && pass "edge function TypeScript typechecks" \
       || fail "edge function TypeScript does not typecheck"; } \
  || skip "deno not installed — edge function TypeScript is NOT typechecked"

# ---------------------------------------------------------------------
printf '\n\033[1mResult\033[0m\n'
printf '  %d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mFAILED\033[0m — do not push until these are fixed.\n\n'
  exit 1
fi
printf '\033[32mPASSED\033[0m\n\n'
exit 0
