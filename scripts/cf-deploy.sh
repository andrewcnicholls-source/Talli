#!/usr/bin/env bash
# =====================================================================
#  Talli — ask Cloudflare what a Pages environment is actually serving.
#
#      bash scripts/cf-deploy.sh production
#      bash scripts/cf-deploy.sh preview
#
#  Prints the current deployment's id, branch, commit, status and URL,
#  one `key: value` per line. `/release-production` reads this rather
#  than inferring the deployed commit from a branch tip — the branch can
#  have moved since the last successful build, and the whole point of
#  the release gate is to promote the commit that was actually tested.
#
#  Needs CLOUDFLARE_API_TOKEN (Pages: Read is enough) and
#  CLOUDFLARE_ACCOUNT_ID in the environment.
#
#  Exits non-zero if it cannot get an answer. A missing answer must not
#  read as "nothing deployed" — the caller has to be able to tell those
#  apart, so silence is always an error here.
#
#      0  answered (an empty `commit:` means a non-git deployment)
#      1  could not get an answer from Cloudflare
#      2  called wrong
#      3  answered, but in a shape this script does not understand —
#         fix the script, do not read it as a fact about the deployment
# =====================================================================
set -uo pipefail

cd "$(dirname "$0")/.."
. scripts/talli-env.sh

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  production|preview) ;;
  *) echo "usage: $0 <production|preview>" >&2; exit 2 ;;
esac

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Pages: Read)}"
: "${TALLI_CF_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

API="https://api.cloudflare.com/client/v4/accounts/${TALLI_CF_ACCOUNT_ID}/pages/projects/${TALLI_CF_PAGES_PROJECT}/deployments?env=${ENVIRONMENT}"

body=$(curl -sS --max-time 30 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$API") || {
  echo "cf-deploy.sh: could not reach the Cloudflare API" >&2
  exit 1
}

PYSRC=$(cat <<'PY'
import json, sys

env = sys.argv[1]
raw = sys.stdin.read()
try:
    doc = json.loads(raw)
except ValueError:
    print("cf-deploy.sh: Cloudflare returned something that is not JSON", file=sys.stderr)
    print(raw[:400], file=sys.stderr)
    sys.exit(1)

if not doc.get("success"):
    print("cf-deploy.sh: Cloudflare refused the request", file=sys.stderr)
    for e in doc.get("errors") or []:
        print(f"  {e.get('code')}: {e.get('message')}", file=sys.stderr)
    sys.exit(1)

results = doc.get("result") or []
if not results:
    print(f"cf-deploy.sh: no {env} deployments found", file=sys.stderr)
    sys.exit(1)

d = results[0]

# Two failures that look identical downstream but need opposite
# responses. A deployment built from someone's working copy genuinely has
# no commit, and the release must stop. A response missing these keys
# altogether means Cloudflare renamed them and this script needs fixing —
# reporting that as "no commit" would send someone hunting a release
# problem that does not exist, on a night when they are trying to ship.
if "deployment_trigger" not in d and "latest_stage" not in d:
    print("cf-deploy.sh: unexpected response shape — neither "
          "deployment_trigger nor latest_stage is present.", file=sys.stderr)
    print("  This means the script needs updating against the current Pages "
          "API.", file=sys.stderr)
    print("  It is NOT a statement about what is deployed.", file=sys.stderr)
    print(f"  keys seen: {', '.join(sorted(d))}", file=sys.stderr)
    sys.exit(3)

trigger = (d.get("deployment_trigger") or {}).get("metadata") or {}
stage = d.get("latest_stage") or {}

# A deployment uploaded from a working copy carries no commit. Print the
# key with an empty value rather than omitting the line, so the caller
# sees the absence instead of missing the field.
print(f"id: {d.get('id') or ''}")
print(f"environment: {d.get('environment') or ''}")
print(f"branch: {trigger.get('branch') or ''}")
print(f"commit: {trigger.get('commit_hash') or ''}")
print(f"status: {stage.get('status') or ''}")
print(f"stage: {stage.get('name') or ''}")
print(f"url: {d.get('url') or ''}")
print(f"created_on: {d.get('created_on') or ''}")
PY
)

printf '%s' "$body" | python3 -c "$PYSRC" "$ENVIRONMENT"
