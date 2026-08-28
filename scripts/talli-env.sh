#!/usr/bin/env bash
# =====================================================================
#  Talli — the one place the environment topology is written down.
#
#  Every skill and script reads this file rather than hardcoding a
#  branch name or a project name. If the topology ever changes — say the
#  Pages project gets re-pointed at different branches — this file is
#  the only thing that has to change.
#
#  Source it, don't run it:  . scripts/talli-env.sh
# =====================================================================

# ---------------------------------------------------------------------
#  Branches
#
#  Two long-lived branches, and they are NOT the conventional names.
#  Cloudflare Pages decides what each one means, and it says:
#
#    staging  -> staging.talli.pages.dev  the shared device-test site
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
#  Cloudflare Pages
#
#  ONE Pages project serves both environments. `main` is its production
#  branch; `staging` is its only enabled preview branch, which gets the
#  stable alias below. Feature branches are deliberately NOT built —
#  every branch build costs against the monthly quota and would publish
#  another un-gated copy of the booking page.
#
#  The account id is read from the environment rather than committed,
#  so a checkout carries no account identifiers. Set it alongside
#  CLOUDFLARE_API_TOKEN. Dashboard -> Workers & Pages -> Account ID.
# ---------------------------------------------------------------------
TALLI_CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
TALLI_CF_PAGES_PROJECT="talli"

TALLI_STAGING_URL="https://staging.talli.pages.dev"
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

# Things Cloudflare Pages does NOT deploy. Changes here need a separate,
# deliberate release step against Supabase.
TALLI_OUT_OF_BAND_PATHS="supabase/migrations supabase/functions"

export TALLI_INTEGRATION_BRANCH TALLI_PRODUCTION_BRANCH TALLI_PROTECTED_BRANCHES
export TALLI_CF_ACCOUNT_ID TALLI_CF_PAGES_PROJECT
export TALLI_STAGING_URL TALLI_PRODUCTION_URL
export TALLI_STAGING_SUPABASE_REF TALLI_PRODUCTION_SUPABASE_REF
export TALLI_WORKTREE_PREFIX TALLI_BRANCH_PREFIX
export TALLI_PAYMENT_PATHS TALLI_BOOKING_PATHS TALLI_OUT_OF_BAND_PATHS
