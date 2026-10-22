#!/usr/bin/env bash
# Remove Bookwyrm from this Mac or Linux computer.
#
#   ~/bookwyrm/uninstall.sh            lists what it will remove, then asks
#   ~/bookwyrm/uninstall.sh --dry-run  only lists it
#   ~/bookwyrm/uninstall.sh --yes      doesn't ask
#
# Runs the setup wizard's --uninstall with the Node.js the installer fetched (or yours).
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node=""
for candidate in "$HOME"/.bookwyrm/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -x "$candidate" ] && "$candidate" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)" 2>/dev/null; then
    node="$candidate"; break
  fi
done
if [ -z "$node" ]; then
  echo "Couldn't find Node.js 22.12 or newer, which the uninstaller runs on."
  echo "Remove Bookwyrm by hand instead: see \"Removing Bookwyrm\" in $dir/docs/setup.md"
  exit 1
fi
exec "$node" "$dir/setup/dist/setup.mjs" --uninstall "$@"
