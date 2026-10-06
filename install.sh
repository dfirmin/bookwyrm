#!/usr/bin/env bash
# Bookwyrm installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --yes --repo owner/name     (options go to the wizard)
#   ./install.sh [options]                                             (from a clone)
#
# Gets Node.js 22 if needed (into ~/.bookwyrm/node, checksum-verified), gets or updates the
# Bookwyrm source (~/bookwyrm, or $BOOKWYRM_DIR), then starts the setup wizard in setup/.
# Safe to run again: it skips whatever is already done.
#
# Everything is inside main(), so a half-downloaded script runs nothing.

main() {
  set -euo pipefail

  local repo_url="https://github.com/dfirmin/bookwyrm"
  local branch="${BOOKWYRM_BRANCH:-main}"
  local bw_home="$HOME/.bookwyrm"
  local node_min_major=22 node_min_minor=12

  say() { printf '%s\n' "$*"; }
  fail() { printf '\nBookwyrm setup stopped: %s\n' "$*" >&2; exit 1; }

  # ---- Node.js -------------------------------------------------------------------------------------
  node_ok() {  # node_ok /path/to/node → is it 22.12 or newer?
    [ -x "$1" ] || return 1
    "$1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$node_min_major||(a===$node_min_major&&b>=$node_min_minor)?0:1)" 2>/dev/null
  }

  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
  }

  download_node() {
    local os arch
    case "$(uname -s)" in
      Darwin) os=darwin ;;
      Linux) os=linux ;;
      *) fail "this installer is for macOS and Linux; on Windows use install.ps1" ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) arch=arm64 ;;
      x86_64|amd64) arch=x64 ;;
      *) fail "no Node.js build for this processor ($(uname -m)); install Node.js 22 yourself and run this again" ;;
    esac
    # A Terminal running under Rosetta reports x86_64 on an Apple Silicon Mac.
    if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = 1 ]; then
      arch=arm64
    fi

    # BOOKWYRM_NODE_MIRROR: a company mirror of https://nodejs.org/dist/latest-v22.x, if you have one.
    local base="${BOOKWYRM_NODE_MIRROR:-https://nodejs.org/dist/latest-v22.x}" tmp sums file want got
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand $tmp now
    trap "rm -rf '$tmp'" RETURN
    say "Getting Node.js 22 for $os-$arch (about 50 MB)…"
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || fail "couldn't reach $base to download Node.js"
    sums="$(grep -E "  node-v22\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -n1)" || true
    [ -n "$sums" ] || fail "$base has no Node.js 22 build for $os-$arch"
    want="${sums%% *}"
    file="${sums##* }"
    curl -fSL --progress-bar "$base/$file" -o "$tmp/$file" || fail "Node.js download failed"
    got="$(sha256_of "$tmp/$file")"
    [ "$got" = "$want" ] || fail "the Node.js download didn't match its checksum; try again"
    mkdir -p "$tmp/node"
    tar -xzf "$tmp/$file" -C "$tmp/node" --strip-components=1
    mkdir -p "$bw_home"
    rm -rf "$bw_home/node"
    mv "$tmp/node" "$bw_home/node"
    say "Node.js $("$bw_home/node/bin/node" --version) is in ~/.bookwyrm/node"
  }

  local node=""
  if node_ok "$(command -v node 2>/dev/null || true)"; then
    node="$(command -v node)"
  elif node_ok "$bw_home/node/bin/node"; then
    node="$bw_home/node/bin/node"
  else
    download_node
    node="$bw_home/node/bin/node"
    node_ok "$node" || fail "the downloaded Node.js doesn't run on this machine"
  fi
  local node_dir
  node_dir="$(cd "$(dirname "$node")" && pwd)"

  # ---- Bookwyrm source -----------------------------------------------------------------------------
  is_bookwyrm() { [ -f "$1/setup/package.json" ] && [ -f "$1/profile/config.yaml" ]; }

  has_git() {
    command -v git >/dev/null 2>&1 || return 1
    # On a Mac without the developer tools, /usr/bin/git is a stub that pops up an installer.
    if [ "$(uname -s)" = Darwin ]; then xcode-select -p >/dev/null 2>&1 || return 1; fi
    git --version >/dev/null 2>&1
  }

  fetch_tarball() {  # unpack the branch's source over $1 (keeps .venv, node_modules and the like)
    mkdir -p "$1"
    say "Downloading Bookwyrm…"
    curl -fsSL "$repo_url/archive/refs/heads/$branch.tar.gz" | tar -xz -C "$1" --strip-components=1 \
      || fail "couldn't download Bookwyrm from GitHub"
  }

  local here="" dir
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [ -n "$here" ] && is_bookwyrm "$here" && [ -z "${BOOKWYRM_DIR:-}" ]; then
    dir="$here"   # run from a clone: use it as it is
  else
    dir="${BOOKWYRM_DIR:-$HOME/bookwyrm}"
    if [ -d "$dir/.git" ] && is_bookwyrm "$dir"; then
      say "Updating Bookwyrm in $dir…"
      if ! { has_git && git -C "$dir" pull --ff-only --quiet; }; then
        say "(Couldn't update it automatically; carrying on with the copy that's there.)"
      fi
    elif is_bookwyrm "$dir"; then
      fetch_tarball "$dir"   # an earlier download without git: refresh it
    elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
      fail "$dir already exists and isn't Bookwyrm. Set BOOKWYRM_DIR to another folder and run this again."
    elif has_git; then
      say "Getting Bookwyrm into $dir…"
      git clone --quiet --branch "$branch" "$repo_url.git" "$dir" || fail "git clone failed"
    else
      fetch_tarball "$dir"
    fi
  fi
  is_bookwyrm "$dir" || fail "$dir doesn't look like Bookwyrm"

  # ---- the wizard ----------------------------------------------------------------------------------
  export PATH="$node_dir:$PATH"
  local npm_cli="$node_dir/../lib/node_modules/npm/bin/npm-cli.js"
  npm_run() { if [ -f "$npm_cli" ]; then "$node" "$npm_cli" "$@"; else npm "$@"; fi; }

  cd "$dir/setup"
  local lock_hash stamp="node_modules/.bookwyrm-installed"
  lock_hash="$("$node" -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('package-lock.json')).digest('hex'))")"
  if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$lock_hash" ]; then
    say "Preparing the setup wizard…"
    npm_run ci --no-audit --no-fund --loglevel=error >/dev/null || fail "couldn't install the setup wizard (npm ci in $dir/setup)"
    printf '%s' "$lock_hash" > "$stamp"
  else
    npm_run run build --silent >/dev/null || fail "couldn't build the setup wizard"
  fi

  # Under `curl | bash` stdin is the script itself; the wizard needs the keyboard.
  if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
    exec "$node" dist/setup.mjs "$@" </dev/tty
  fi
  exec "$node" dist/setup.mjs "$@"
}

main "$@"
