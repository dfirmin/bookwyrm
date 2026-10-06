#!/usr/bin/env bash
# Kept for old instructions: setup is now the wizard started by ../install.sh.
#   ./scripts/install.sh [--repo owner/name] [--github-mcp-bin PATH] [other wizard options]
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh" "$@"
