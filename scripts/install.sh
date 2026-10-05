#!/usr/bin/env bash
# Create or refresh the Bookwyrm Hermes profile.
#
#   ./scripts/install.sh --repo <owner>/<knowledge-repo> [--profile bookwyrm]
#
# Safe to re-run: config.yaml and SOUL.md are refreshed from profile/; .env, memories and
# sessions are never touched.
set -euo pipefail

repo=""
profile="bookwyrm"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --profile) profile="${2:-}"; shift 2 ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "--repo <owner>/<name> is required (the Archivist knowledge repo)" >&2
  exit 2
fi
command -v hermes >/dev/null || { echo "hermes is not on PATH; install Hermes Agent first" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_dir="${HERMES_HOME:-$HOME/.hermes}/profiles/$profile"

if [ ! -d "$profile_dir" ]; then
  # --no-skills: Bookwyrm sees only its own skills, not Hermes' bundled ones.
  hermes profile create "$profile" --no-skills \
    --description "Librarian for the Archivist knowledge repo $repo: answers from it, records SME knowledge, resolves gaps and quarantine by pull request."
fi
[ -d "$profile_dir" ] || { echo "profile directory not found: $profile_dir" >&2; exit 1; }

# Fill placeholders without sed, so paths and repo names need no escaping.
render() {  # render <src> <dest>
  python3 - "$1" "$2" "$here/skills" "$repo" <<'PY'
import sys
src, dest, skills, repo = sys.argv[1:]
text = open(src, encoding="utf-8").read()
text = text.replace("__BOOKWYRM_SKILLS__", skills).replace("{{TARGET_REPO}}", repo)
open(dest, "w", encoding="utf-8").write(text)
PY
}

render "$here/profile/config.yaml" "$profile_dir/config.yaml"
render "$here/profile/SOUL.md" "$profile_dir/SOUL.md"

# Hermes seeds an empty .env on create; add our template once, never overwrite values.
touch "$profile_dir/.env"
chmod 600 "$profile_dir/.env"
if ! grep -q '^GITHUB_PERSONAL_ACCESS_TOKEN=' "$profile_dir/.env"; then
  { echo; cat "$here/profile/.env.example"; } >> "$profile_dir/.env"
  env_note="Fill in $profile_dir/.env (GitHub token and model key)."
else
  env_note="Kept your existing $profile_dir/.env."
fi

cat <<EOF
Bookwyrm profile ready: $profile_dir
  knowledge repo: $repo
  skills:         $here/skills
$env_note
Then: $profile chat    (or: hermes -p $profile chat)
EOF
