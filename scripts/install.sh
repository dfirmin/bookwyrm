#!/usr/bin/env bash
# Create or refresh the Bookwyrm Hermes profile.
#
#   ./scripts/install.sh --repo <owner>/<knowledge-repo> [--profile bookwyrm]
#                        [--github-mcp-bin /path/to/github-mcp-server]
#
# --github-mcp-bin runs the GitHub MCP server's release binary instead of its Docker image.
#
# Safe to re-run: config.yaml and SOUL.md are refreshed from profile/; .env, memories and
# sessions are never touched.
set -euo pipefail

repo=""
profile="bookwyrm"
mcp_bin=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --profile) profile="${2:-}"; shift 2 ;;
    --github-mcp-bin) mcp_bin="${2:-}"; shift 2 ;;
    -h|--help) sed -n 2,11p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "--repo <owner>/<name> is required (the Archivist knowledge repo)" >&2
  exit 2
fi
if [ -n "$mcp_bin" ] && [ ! -x "$mcp_bin" ]; then
  echo "--github-mcp-bin: not an executable file: $mcp_bin" >&2
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
  python3 - "$1" "$2" "$here/skills" "$repo" "$mcp_bin" <<'PY'
import json, re, sys
src, dest, skills, repo, mcp_bin = sys.argv[1:]
text = open(src, encoding="utf-8").read()
text = text.replace("__BOOKWYRM_SKILLS__", skills).replace("{{TARGET_REPO}}", repo)
if mcp_bin and dest.endswith("config.yaml"):
    # Swap the Docker launch for the release binary; the env and tool allow-list stay as they are.
    docker = re.compile(r'    command: "docker"\n    args:\n(?:      - .*\n)+')
    text, n = docker.subn(f'    command: {json.dumps(mcp_bin)}\n    args: ["stdio"]\n', text)
    if n != 1:
        sys.exit("install.sh: could not find the Docker launch block in profile/config.yaml")
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
