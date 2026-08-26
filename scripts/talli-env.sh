#!/usr/bin/env bash
# =====================================================================
#  Talli — the one place the environment topology is written down.
#
#  Every skill and script reads this file rather than hardcoding a
#  branch name or a site id. If the topology ever changes — say the
#  Netlify projects get re-pointed at different branches — this file is
#  the only thing that has to change.
#
#  Source it, don't run it:  . scripts/talli-env.sh
# =====================================================================

# ---------------------------------------------------------------------
#  Branches
#
#  Two long-lived branches, and they are NOT the conventional names.
#  Netlify decides what each one means, and Netlify says:
#
#    staging  -> talli-test.netlify.app   the shared device-test site
#    main     -> talli.co.nz              real customers, real money
#
#  So `staging` is the integration branch: feature branches merge there,
#  it deploys to the test site, and it is what gets device-tested.
#  `main` is the RELEASE branch: a commit arrives on it only by being
#  promoted from staging after that testing. Merging to main is a
#  production deployment.
# ---------------------------------------------------------------------
TALLI_INTEGRATION_BRANCH="staging"
TALLI_PRODUCTION_BRANCH="main"

# Branches an agent must never commit to directly.
TALLI_PROTECTED_BRANCHES="main staging"

# ---------------------------------------------------------------------
#  Netlify projects
# ---------------------------------------------------------------------
TALLI_STAGING_SITE_NAME="talli-test"
TALLI_STAGING_SITE_ID="ec2dd376-9da5-428b-bdd7-3a496a796841"
TALLI_STAGING_URL="https://talli-test.netlify.app"

TALLI_PRODUCTION_SITE_NAME="talliconz"
TALLI_PRODUCTION_SITE_ID="a290ff77-40ca-4238-9ac1-e91736b3fd7d"
TALLI_PRODUCTION_URL="https://talli.co.nz"

# ---------------------------------------------------------------------
#  Supabase projects (database + edge functions + payment secrets)
# ---------------------------------------------------------------------
TALLI_STAGING_SUPABASE_REF="uhdoverwvlxvyyctskle"
TALLI_PRODUCTION_SUPABASE_REF="oxzwfemyavznykqixhvk"

# ---------------------------------------------------------------------
#  Worktree layout
#
#  Worktrees are siblings of the repo root, never inside it — a worktree
#  nested inside its own repository confuses git status and risks being
#  committed by accident.
# ---------------------------------------------------------------------
TALLI_WORKTREE_PREFIX="Talli-"
TALLI_BRANCH_PREFIX="feature/"

# ---------------------------------------------------------------------
#  Paths where a change is payment-critical or booking-critical.
#  release-production calls these out explicitly in its release summary.
# ---------------------------------------------------------------------
TALLI_PAYMENT_PATHS="supabase/functions/create-checkout supabase/functions/stripe-webhook supabase/functions/check-setup assets/booking.js assets/confirmed.js booking-confirmed.html"
TALLI_BOOKING_PATHS="assets/booking.js assets/admin.js supabase/functions/gate-ops supabase/functions/get-booking book.html admin.html"

# Things Netlify does NOT deploy. Changes here need a separate,
# deliberate release step against Supabase.
TALLI_OUT_OF_BAND_PATHS="supabase/migrations supabase/functions"

export TALLI_INTEGRATION_BRANCH TALLI_PRODUCTION_BRANCH TALLI_PROTECTED_BRANCHES
export TALLI_STAGING_SITE_NAME TALLI_STAGING_SITE_ID TALLI_STAGING_URL
export TALLI_PRODUCTION_SITE_NAME TALLI_PRODUCTION_SITE_ID TALLI_PRODUCTION_URL
export TALLI_STAGING_SUPABASE_REF TALLI_PRODUCTION_SUPABASE_REF
export TALLI_WORKTREE_PREFIX TALLI_BRANCH_PREFIX
export TALLI_PAYMENT_PATHS TALLI_BOOKING_PATHS TALLI_OUT_OF_BAND_PATHS
