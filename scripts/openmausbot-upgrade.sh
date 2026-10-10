#!/usr/bin/env bash
# Install or upgrade a self-hosted OpenMausBot, including its native modules.
#
#   scripts/openmausbot-upgrade.sh            # install/upgrade to the latest npm release
#   scripts/openmausbot-upgrade.sh 0.1.105    # a specific version (also rolls back)
#
# The npm package does not ship its native modules (DuckDB for the data tools
# and charts, resvg for chart images). Without them OpenMausBot's data
# features fail and omb-webreports cannot run. So this also installs the
# versions the release pins (read from the matching vX.Y.Z tag on GitHub) into
# /usr/lib/node_modules, and makes sure the systemd drop-in
# OMB_DUCKDB_DIR=/usr/lib points the service there. Uses sudo where needed.
# See docs/setup.md.
set -euo pipefail

REPO=milind-soni/OpenMausBot
SERVICE=openmausbot
NATIVE_MODULES=(@duckdb/node-api @resvg/resvg-js)

current=$(npm ls -g openmausbot --depth=0 --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).dependencies.openmausbot.version)}catch{console.log("none")}})')
target=${1:-$(npm view openmausbot version)}

echo "openmausbot: installed $current, target $target"

pkg=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/v$target/package.json") || pkg=""
if [[ -z $pkg ]]; then
  echo "warning: could not read package.json for v$target; leaving native modules as is" >&2
fi

if [[ $current == "$target" ]]; then
  echo "openmausbot $target already installed"
else
  sudo npm install -g "openmausbot@$target"
fi

for mod in "${NATIVE_MODULES[@]}"; do
  [[ -n $pkg ]] || break
  want=$(MOD=$mod node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p.dependencies?.[process.env.MOD]??"")})' <<<"$pkg")
  if [[ -z $want ]]; then
    echo "warning: v$target does not pin $mod; leaving it as is" >&2
    continue
  fi
  have=$(node -p "require('/usr/lib/node_modules/$mod/package.json').version" 2>/dev/null || echo none)
  if [[ $have == "$want" ]]; then
    echo "$mod $want already installed"
  else
    echo "$mod: installed $have, target $want"
    sudo npm install -g "$mod@$want"
  fi
done

# The service looks for the native modules in $OMB_DUCKDB_DIR/node_modules.
DROPIN=/etc/systemd/system/$SERVICE.service.d/duckdb.conf
if [[ ! -f $DROPIN ]]; then
  echo "adding $DROPIN (OMB_DUCKDB_DIR=/usr/lib)"
  sudo mkdir -p "$(dirname "$DROPIN")"
  printf '[Service]\nEnvironment=OMB_DUCKDB_DIR=/usr/lib\n' | sudo tee "$DROPIN" >/dev/null
  sudo systemctl daemon-reload
fi

if ! systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
  echo "openmausbot $target and its native modules are installed."
  echo "No $SERVICE.service yet: create it with 'openmausbot service install --tailscale' (docs/setup.md, step 4), then re-run this script."
  exit 0
fi

sudo systemctl restart "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || {
  echo "error: $SERVICE did not stay up; recent logs:" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
}
echo "$SERVICE is running openmausbot $target"
journalctl -u "$SERVICE" -n 5 --no-pager
