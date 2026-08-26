#!/usr/bin/env bash
# =====================================================================
#  Package the agent skills for upload to a Claude account.
#
#      bash scripts/package-skills.sh [outdir]
#
#  Skills in this repository's .claude/skills/ are only visible to a
#  Claude Code session that has this repository checked out. Uploading
#  them to your account instead syncs them into EVERY Claude Code
#  session — any repository, any machine, including the ephemeral
#  containers Claude Code on the web runs in.
#
#  Upload at: claude.ai -> Settings -> Capabilities -> Skills
#
#  Re-run this after changing any SKILL.md and re-upload, or the
#  account copy drifts from the repository copy.
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-dist/skills}"

command -v zip >/dev/null || { echo "zip is not installed."; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

for dir in .claude/skills/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || { echo "skip $name — no SKILL.md"; continue; }

  # A skill uploads as a zip containing ONE top-level directory named
  # after the skill, with SKILL.md inside it.
  staging="$(mktemp -d)"
  cp -R "$dir" "$staging/$name"
  ( cd "$staging" && zip -qr "$name.zip" "$name" )
  mv "$staging/$name.zip" "$OUT/"
  rm -rf "$staging"

  printf '  %-22s %s\n' "$name" "$OUT/$name.zip"
done

cat <<'NOTE'

Upload these at claude.ai -> Settings -> Capabilities -> Skills.

  new-agent, finish-agent, cleanup-agent
      Work in any git repository. They read scripts/talli-env.sh when
      it is there and derive the topology from the remote's default
      branch when it is not.

  release-production
      Talli only. It refuses to run anywhere else, by design — it
      knows this application's Netlify and Supabase projects by id and
      none of that transfers. Upload it if you want it on hand; it
      will decline politely in any other repository.

Once uploaded they appear in every Claude Code session. This
repository's copies stay the source of truth — re-run this script and
re-upload after any change.
NOTE
