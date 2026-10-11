#!/usr/bin/env bash
# Install or upgrade a self-hosted OpenMausBot and its native modules, and keep
# the browser's DuckDB on the same version as OpenMausBot's.
#
#   sudo admin/openmausbot-upgrade.sh                  # the latest npm release
#   sudo admin/openmausbot-upgrade.sh 0.1.107          # a specific version (also rolls back)
#   admin/openmausbot-upgrade.sh --check               # show the versions; change nothing
#   sudo admin/openmausbot-upgrade.sh --skip-browser-check [version]
#
# Native modules: the npm package does not ship them (DuckDB for the data tools
# and charts, resvg for chart images). Without them OpenMausBot's data features
# fail and omb-webreports cannot run. So this installs the versions the release
# pins (read from its vX.Y.Z tag on GitHub) into /usr/lib/node_modules, and
# makes sure the systemd drop-in OMB_DUCKDB_DIR=/usr/lib points the service there.
#
# Browser DuckDB: reports run DuckDB-WASM, which must contain the same DuckDB
# engine as the release's @duckdb/node-api (same SQL, same results, same file
# format). Before changing anything, this finds that DuckDB-WASM build. If
# there is none, it names the newest OpenMausBot release that has one and asks
# whether to continue anyway; without a terminal to ask on, it stops.
# --skip-browser-check upgrades regardless. After upgrading, it sets
# DUCKDB_WASM_VERSION in /etc/omb-webreports/config.env, re-stamps the shared
# pages and restarts webdata-sync/webdata-jobs. (Before omb-webreports is
# installed there is no config yet; admin/install.sh then picks the build.)
#
# Skills: finally runs webdata-skills sync, which updates the bots' copies of
# the omb-webreports skills and the Report builder preset.
#
# Run it with sudo from the root-owned clone (like admin/install.sh), or add
# --from-unsafe-dev from a development checkout. See docs/setup.md.
set -euo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
# shellcheck source=_lib.sh
source "$ROOT/admin/_lib.sh"
HELPER=$ROOT/admin/duckdb-wasm.mjs
CONFIG=/etc/omb-webreports/config.env
PREFIX=/usr/local/lib/omb-webreports
REPO=milind-soni/OpenMausBot
SERVICE=openmausbot
MODULES_DIR=/usr/lib/node_modules
NATIVE_MODULES=(@duckdb/node-api @resvg/resvg-js)

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; }

skip_check=0 check_only=0 unsafe=0 target=""
for arg in "$@"; do
  case $arg in
    --skip-browser-check) skip_check=1 ;;
    --check) check_only=1 ;;
    --from-unsafe-dev) unsafe=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    *) target=$arg ;;
  esac
done

if [[ ! -f $HELPER ]]; then
  echo "error: run this from an omb-webreports checkout ($HELPER is missing)" >&2
  exit 2
fi
if (( ! check_only )); then
  (( EUID == 0 )) || die "run as root: sudo $0 (it installs global npm modules and writes $CONFIG)"
  check_source "$ROOT" "$unsafe"
fi

kv() { sed -n "s/^$1=//p" | head -1; }                 # kv <key> <<< "key=value lines"
installed_version() { node -p "require('$MODULES_DIR/$1/package.json').version" 2>/dev/null || echo none; }
wasm_engine() { node "$HELPER" engine "$1" 2>/dev/null | kv engine || true; }

current=$(npm ls -g openmausbot --depth=0 --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).dependencies.openmausbot.version)}catch{console.log("none")}})')
wasm_now=$(node --input-type=module -e "console.log((await import('$ROOT/bin/_config.mjs')).DUCKDB_WASM_VERSION)")

# ---------------------------------------------------------------- --check

if (( check_only )); then
  api=$(installed_version @duckdb/node-api)
  server_engine=$([[ $api == none ]] && echo "?" || echo "v${api%%-*}")
  browser_engine=$(wasm_engine "$wasm_now")
  echo "openmausbot:  $current, @duckdb/node-api $api (DuckDB $server_engine)"
  echo "browser:      DuckDB-WASM $wasm_now (DuckDB ${browser_engine:-unknown})"
  status=0
  if [[ -n $browser_engine && $server_engine == "$browser_engine" ]]; then
    echo "match:        yes"
  else
    echo "match:        NO; run: sudo admin/openmausbot-upgrade.sh $current"
    status=1
  fi
  if latest=$(node "$HELPER" omb-match); then
    echo "newest openmausbot with a matching browser build: $(kv omb <<<"$latest") (DuckDB $(kv engine <<<"$latest"), DuckDB-WASM $(kv wasm <<<"$latest"))"
  else
    echo "newest openmausbot with a matching browser build: none found"
  fi
  exit $status
fi

# ---------------------------------------------------------------- what to install

target=${target:-$(npm view openmausbot version)}
echo "openmausbot: installed $current, target $target"

pkg=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/v$target/package.json") || pkg=""
if [[ -z $pkg ]]; then
  echo "warning: could not read package.json for v$target; leaving native modules as is" >&2
fi
pinned() { [[ -n $pkg ]] && MOD=$1 node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).dependencies?.[process.env.MOD]??"")})' <<<"$pkg"; }
want_api=$(pinned @duckdb/node-api || true)

# ---------------------------------------------------------------- browser DuckDB check (before changing anything)

new_wasm=""
if (( skip_check )); then
  echo "browser check skipped (--skip-browser-check): reports stay on DuckDB-WASM $wasm_now"
else
  reason=""
  if [[ -z $want_api ]]; then
    reason="couldn't tell which DuckDB openmausbot $target uses"
  elif out=$(node "$HELPER" match "$want_api"); then
    new_wasm=$(kv wasm <<<"$out")
    echo "browser: DuckDB-WASM $new_wasm contains DuckDB $(kv engine <<<"$out"), the same as openmausbot $target (@duckdb/node-api $want_api)"
  else
    rc=$?
    if (( rc == 3 )); then reason="no DuckDB-WASM build contains DuckDB v${want_api%%-*} (@duckdb/node-api $want_api) yet"
    else reason="couldn't look up DuckDB-WASM builds (see the message above)"; fi
  fi

  if [[ -z $new_wasm ]]; then
    echo >&2
    echo "Can't keep the browser's DuckDB equal to openmausbot $target: $reason." >&2
    if latest=$(node "$HELPER" omb-match "$target"); then
      echo "Newest openmausbot release with a matching browser build: $(kv omb <<<"$latest") (DuckDB $(kv engine <<<"$latest"), DuckDB-WASM $(kv wasm <<<"$latest"))." >&2
      echo "  To install that instead: sudo admin/openmausbot-upgrade.sh $(kv omb <<<"$latest")" >&2
    else
      echo "No openmausbot release up to $target has a matching browser build." >&2
    fi
    echo "Continuing keeps reports on DuckDB-WASM $wasm_now (DuckDB $(wasm_engine "$wasm_now")) while the bots run another DuckDB." >&2
    if [[ -t 0 && -t 1 ]]; then
      read -r -p "Upgrade to openmausbot $target anyway? [y/N] " answer
      if [[ ! $answer =~ ^[Yy] ]]; then echo "Nothing changed."; exit 1; fi
    else
      echo "error: not an interactive terminal, so not asking. Nothing changed." >&2
      echo "  To upgrade anyway: sudo admin/openmausbot-upgrade.sh --skip-browser-check $target" >&2
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------- install

changed=0
if [[ $current == "$target" ]]; then
  echo "openmausbot $target already installed"
else
  npm install -g "openmausbot@$target"
  changed=1
fi

for mod in "${NATIVE_MODULES[@]}"; do
  [[ -n $pkg ]] || break
  want=$(pinned "$mod" || true)
  if [[ -z $want ]]; then
    echo "warning: v$target does not pin $mod; leaving it as is" >&2
    continue
  fi
  have=$(installed_version "$mod")
  if [[ $have == "$want" ]]; then
    echo "$mod $want already installed"
  else
    echo "$mod: installed $have, target $want"
    npm install -g "$mod@$want"
    changed=1
  fi
done

# The service looks for the native modules in $OMB_DUCKDB_DIR/node_modules.
DROPIN=/etc/systemd/system/$SERVICE.service.d/duckdb.conf
if [[ ! -f $DROPIN ]]; then
  echo "adding $DROPIN (OMB_DUCKDB_DIR=/usr/lib)"
  mkdir -p "$(dirname "$DROPIN")"
  printf '[Service]\nEnvironment=OMB_DUCKDB_DIR=/usr/lib\n' > "$DROPIN"
  systemctl daemon-reload
fi

# ---------------------------------------------------------------- browser DuckDB pin

# Always written explicitly, so a later change to the default in bin/_config.mjs
# (git pull) can't move the browser away from this machine's OpenMausBot.
pin_changed=0
if [[ -n $new_wasm && ! -f $CONFIG ]]; then
  echo "browser: omb-webreports isn't installed yet; admin/install.sh will use DuckDB-WASM $new_wasm"
elif [[ -n $new_wasm ]]; then
  [[ $new_wasm =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "error: unexpected DuckDB-WASM version '$new_wasm'" >&2; exit 1; }
  before_pin=$(grep '^DUCKDB_WASM_VERSION=' "$CONFIG" || true)
  if grep -q '^DUCKDB_WASM_VERSION=' "$CONFIG"; then
    if ! grep -qx "DUCKDB_WASM_VERSION=$new_wasm" "$CONFIG"; then
      sed -i "s/^DUCKDB_WASM_VERSION=.*/DUCKDB_WASM_VERSION=$new_wasm/" "$CONFIG"
      changed=1
    fi
  else
    printf '\n# Set by admin/openmausbot-upgrade.sh: the DuckDB-WASM build with the same DuckDB as OpenMausBot.\nDUCKDB_WASM_VERSION=%s\n' "$new_wasm" >> "$CONFIG"
    changed=1
  fi
  echo "browser: DUCKDB_WASM_VERSION=$new_wasm in $CONFIG"
  [[ $before_pin == "DUCKDB_WASM_VERSION=$new_wasm" ]] || pin_changed=1
fi
# The shared pages (front page, gallery, template) carry the browser build in
# their import maps; they're root-owned, so they're re-stamped here.
if (( pin_changed )) && [[ -x $PREFIX/bin/webdata-sync ]]; then
  node "$PREFIX/bin/webdata-sync" --platform | sed 's/^/  /'
fi

# webdata-sync and webdata-jobs load @duckdb/node-api when they start, and sync
# writes the browser build into every page; restart them to pick up changes.
if (( changed )); then
  units=()
  for u in webdata-sync webdata-jobs; do systemctl cat "$u.service" >/dev/null 2>&1 && units+=("$u"); done
  if (( ${#units[@]} )); then
    echo "restarting ${units[*]}"
    systemctl restart "${units[@]}"
  fi
fi

# ---------------------------------------------------------------- OpenMausBot service

if ! systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
  echo "openmausbot $target and its native modules are installed."
  echo "No $SERVICE.service yet: create it with 'openmausbot service install --tailscale' (docs/setup.md, step 4), then re-run this script."
  exit 0
fi

systemctl restart "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || {
  echo "error: $SERVICE did not stay up; recent logs:" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
}
echo "$SERVICE is running openmausbot $target"
journalctl -u "$SERVICE" -n 5 --no-pager

# Bots keep their own copy of each omb-webreports skill; bring them (and the
# Report builder preset) up to date. The installed program, as root: when
# OpenMausBot is isolated, sync uses a root-only session.
if [[ -x $PREFIX/bin/webdata-skills ]]; then
  echo
  echo "bots' skills (webdata-skills sync):"
  "$PREFIX/bin/webdata-skills" sync 2>&1 | sed 's/^/  /' || echo "warning: couldn't update the bots' skills; run: sudo webdata-skills sync" >&2
fi
