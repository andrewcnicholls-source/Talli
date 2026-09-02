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
