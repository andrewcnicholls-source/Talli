#!/usr/bin/env bash
# =====================================================================
#  Deploy-time step for the Talli sites.
#
#  Deliberately does nothing at all unless SITE_NAME says this is the test
#  project. Production must publish byte-for-byte what is in the repo, so
#  the safe path through this script is the empty one.
#
#  Never exits non-zero. A failure to write a robots file is not a reason
#  to fail a deploy of the booking site.
# =====================================================================
set -u

if [ "${SITE_NAME:-}" != "talli-test" ]; then
  echo "build.sh: SITE_NAME='${SITE_NAME:-unset}' is not the test project — nothing to do."
  exit 0
fi

echo "build.sh: test project detected, writing noindex rules."

# Keep the whole test site out of search results. Two mechanisms, because
# crawlers honour them inconsistently: robots.txt asks them not to fetch,
# the header tells them not to index what they did fetch.
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
