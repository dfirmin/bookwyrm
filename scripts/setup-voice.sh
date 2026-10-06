#!/usr/bin/env bash
# Set up Bookwyrm's voice: the call service (../voice) and the desktop companion (../app).
#
#   ./scripts/setup-voice.sh --caller "Dee Firmin, Data Engineering" [--repo owner/knowledge-repo]
#
# Run after scripts/install.sh. Safe to re-run. It:
#   1. creates voice/.venv (Python 3.12 via uv) and installs the voice service
#   2. turns on Hermes' local API so the voice service can talk to the bookwyrm profile
#   3. downloads the speech models once (~1 GB, from GitHub)
#   4. installs and builds the companion app
# Secrets are never copied: the voice service reads Bookwyrm's API key and GitHub token from the
# bookwyrm profile's own .env.
set -euo pipefail

caller=""
repo=""
profile="bookwyrm"
while [ $# -gt 0 ]; do
  case "$1" in
    --caller) caller="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --profile) profile="${2:-}"; shift 2 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$caller" ] || { echo '--caller "Your Name, Team" is required' >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
profile_env="$hermes_home/profiles/$profile/.env"
command -v hermes >/dev/null || { echo "hermes is not on PATH; install Hermes first" >&2; exit 1; }
[ -f "$profile_env" ] || { echo "No $profile profile yet; run scripts/install.sh first" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---- 1. voice service -------------------------------------------------------------------------
step "1/4 Voice service"
if ! command -v uv >/dev/null; then
  if [ -x "$HOME/.local/bin/uv" ]; then export PATH="$HOME/.local/bin:$PATH"
  else curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; fi
fi
uv venv --quiet --allow-existing --python 3.12 "$here/voice/.venv"
uv pip install --quiet --python "$here/voice/.venv/bin/python" -e "$here/voice"
echo "  installed into voice/.venv"

# ---- 2. Hermes API ----------------------------------------------------------------------------
step "2/4 Hermes local API"
key() { "$here/voice/.venv/bin/python" -c 'import secrets; print(secrets.token_urlsafe(24))'; }
add_once() {  # add_once FILE KEY VALUE — only if KEY isn't already set
  touch "$1"; chmod 600 "$1"
  grep -q "^$2=" "$1" || printf '%s=%s\n' "$2" "$3" >> "$1"
}
add_once "$hermes_home/.env" API_SERVER_ENABLED true
add_once "$hermes_home/.env" API_SERVER_KEY "$(key)"
add_once "$profile_env" API_SERVER_KEY "$(key)"
hermes config set gateway.multiplex_profiles true >/dev/null
warn=""
# The API server's web stack (aiohttp) is an optional Hermes extra.
if ! out=$(hermes pm install --extra sms 2>&1); then
  warn="Hermes couldn't add its API server package: $(printf '%s' "$out" | tail -1)
  Fix that, then run:  hermes pm install --extra sms && hermes gateway restart"
  echo "  ! $warn"
fi
hermes gateway install --if-missing >/dev/null 2>&1 || true
hermes gateway restart >/dev/null 2>&1 || hermes gateway start >/dev/null 2>&1 || true
echo "  Hermes serves the $profile profile at http://127.0.0.1:8642/p/$profile/v1"

{
  echo "# Bookwyrm voice settings. Secrets live in $profile_env, not here."
  echo "BOOKWYRM_CALLER=$caller"
  [ -n "$repo" ] && echo "BOOKWYRM_REPO=$repo"
  echo "BOOKWYRM_HERMES_URL=http://127.0.0.1:8642/p/$profile/v1"
  echo "BOOKWYRM_PROFILE_ENV=$profile_env"
  echo "BOOKWYRM_VOICE=af_heart"
} > "$here/voice/.env"
echo "  wrote voice/.env"

# ---- 3. speech models -------------------------------------------------------------------------
step "3/4 Speech models (one-time download, ~1 GB)"
"$here/voice/.venv/bin/python" -c "from bookwyrm_voice.config import load_settings; from bookwyrm_voice.models import ensure_all; ensure_all(load_settings().models_dir)"
echo "  models in ~/.bookwyrm/models"

# ---- 4. companion app -------------------------------------------------------------------------
step "4/4 Companion app"
command -v npm >/dev/null || { echo "npm not found: install Node.js 20+ (https://nodejs.org) and re-run" >&2; exit 1; }
(cd "$here/app" && npm install --silent && npm run build >/dev/null 2>&1)
echo "  built app/"

[ -n "$warn" ] && { step "One thing needs attention"; echo "  $warn"; }
step "Done. Start Bookwyrm with:"
echo "  cd \"$here/app\" && npm start"
