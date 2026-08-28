#!/usr/bin/env bash
# =====================================================================
#  Deploy-time step for the Talli sites, run by Cloudflare Pages.
#
#  Deliberately does nothing at all unless this is a non-production
#  build. Production must publish byte-for-byte what is in the repo, so
#  the safe path through this script is the empty one.
#
#  Cloudflare sets CF_PAGES_BRANCH on every build. Anything that is not
#  the production branch is a test build and gets the noindex rules —
#  the same default-to-test posture as assets/talli-config.js, so a
#  preview branch nobody anticipated is kept out of Google too.
#
#  Never exits non-zero. A failure to write a robots file is not a
#  reason to fail a deploy of the booking site.
# =====================================================================
set -u

cd "$(dirname "$0")/.."
. scripts/talli-env.sh

if [ "${CF_PAGES_BRANCH:-}" = "$TALLI_PRODUCTION_BRANCH" ]; then
  echo "build.sh: CF_PAGES_BRANCH='${CF_PAGES_BRANCH:-}' is the production branch — nothing to do."
  exit 0
fi

echo "build.sh: non-production branch '${CF_PAGES_BRANCH:-unset}', writing noindex rules."

cat > robots.txt <<'ROBOTS'
# Test site. Not for indexing — the live site is https://talli.co.nz
User-agent: *
Disallow: /
ROBOTS

cat > _headers <<'HEADERS'
/*
  X-Robots-Tag: noindex, nofollow, noarchive
HEADERS

echo "build.sh: wrote robots.txt and _headers."
exit 0
