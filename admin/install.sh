#!/usr/bin/env bash
# omb-webreports installer. Root runs it, so run it from a root-owned clone:
#
#   sudo git clone https://github.com/ckedwards/omb-webreports /usr/local/src/omb-webreports
#   sudo /usr/local/src/omb-webreports/admin/install.sh     first install asks a few questions
#   sudo webdata-admin update                               later: git pull, then this
#                                                           (= sudo /usr/local/src/omb-webreports/admin/update.sh)
#
# Options:
#   --print              show every system file it would write; change nothing
#   --yes                first install: take the defaults (or answers from the
#                        environment, e.g. WEBREPORTS_OWNER=you) without asking
#   --migrate-from DIR   first install: take the settings, reports, jobs and
#                        sync.json from an old-layout checkout (e.g. ~/webdata)
#   --from-unsafe-dev    install from a checkout a non-root user can write
#                        (development). Logged as unsafe; never for production.
#   --destdir DIR        testing: write everything under DIR, skip what needs root
#
# What it sets up:
#   /usr/local/lib/omb-webreports      the program: a root-owned copy of the tools,
#                                      skills, template, agent docs and site files
#   /etc/omb-webreports/config.env     settings (root-owned); installed.json says
#                                      which source and commit is installed
#   DATA_DIR (/var/lib/omb-webreports) your reports, published data, jobs and state,
#                                      owned by WEBREPORTS_OWNER (who runs OpenMausBot)
#   Apache (dedicated to this site, on 127.0.0.1 only), webdata-gate (the front
#   door tailscale serve/Funnel send people to: password access), webdata-sync,
#   webdata-jobs, webdata-notify (failure alerts, root), the OpenMausBot isolation
#   drop-in and session timer, and the webdata-* tools in /usr/local/bin.
set -euo pipefail

SRC=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
# shellcheck source=_lib.sh
source "$SRC/admin/_lib.sh"

PRINT=0 YES=0 UNSAFE=0 D="" MIGRATE=""
while (( $# )); do
  case $1 in
    --print) PRINT=1 ;;
    --yes) YES=1 ;;
    --from-unsafe-dev) UNSAFE=1 ;;
    --migrate-from) MIGRATE=$(readlink -f "${2:?--migrate-from needs a directory}"); shift ;;
    --destdir) D=$(readlink -f "${2:?--destdir needs a directory}"); shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
TEST=0; [[ -n $D ]] && TEST=1
(( TEST || PRINT || EUID == 0 )) || die "run as root: sudo $0"

PREFIX=/usr/local/lib/omb-webreports
CONF_DIR=/etc/omb-webreports
CONFIG=$CONF_DIR/config.env
LOOPBACK_DROPIN=/etc/systemd/system/openmausbot.service.d/omb-webreports-loopback.conf
TOOLS=(webdata-info webdata-ls webdata-sql webdata-check webdata-new-report webdata-job webdata-browse webdata-errors webdata-sync webdata-bake webdata-skills webdata-notify webdata-admin webdata-access)
GATE_USER=omb-webreports-gate
# The site's own Tailscale node: its user, and the LocalAPI socket (as bin/_config.mjs SITE_TS_SOCKET).
TS_USER=omb-webreports-tailscale
TS_SOCKET=/run/$TS_USER/tailscaled.sock
NODE=$(command -v node || true)
[[ -n $NODE ]] || die "node not found (Node.js 20+ is required; see docs/setup.md)"
asowner() { if (( TEST )); then "$@"; else runuser -u "$WEBREPORTS_OWNER" -- "$@"; fi; }

# --- the source: root runs all of it ---------------------------------------------
check_source "$SRC" "$UNSAFE"

# --- settings --------------------------------------------------------------------
declare -A OLD=()
if [[ -n $MIGRATE ]]; then
  [[ -d $MIGRATE/webroot ]] || die "--migrate-from $MIGRATE: not an old-layout checkout (no webroot/)"
  while IFS='=' read -r k v; do OLD[$k]=$v; done < <(read_env_file "$MIGRATE/config.env")
fi
# The value for KEY: environment, then the old checkout's config.env, then DEFAULT.
answer_default() { local k=$1 def=$2; [[ -n ${!k:-} ]] && def=${!k}; [[ -n ${OLD[$k]:-} ]] && def=${OLD[$k]}; printf '%s' "$def"; }
ask() {
  local k=$1 q=$2 def=$3 a=""
  def=$(answer_default "$k" "$def")
  if (( ! YES )) && [[ -t 0 ]]; then read -r -p "$q [$def]: " a; fi
  printf -v "$k" '%s' "${a:-$def}"
}

first_run_config() {
  echo "First install: a few settings for $D$CONFIG (change them there later, then re-run this)."
  local owner_def=${SUDO_USER:-}; [[ $owner_def == root ]] && owner_def=""
  ask WEBREPORTS_OWNER "The user that runs OpenMausBot (owns the reports and jobs)" "$owner_def"
  [[ -n $WEBREPORTS_OWNER && $WEBREPORTS_OWNER != root ]] || die "WEBREPORTS_OWNER must be the (non-root) user that runs OpenMausBot"
  id "$WEBREPORTS_OWNER" >/dev/null 2>&1 || die "user $WEBREPORTS_OWNER does not exist"
  local home; home=$(getent passwd "$WEBREPORTS_OWNER" | cut -d: -f6)
  ask DATA_DIR "Where your reports, published data and jobs live" /var/lib/omb-webreports
  LISTEN_IP=127.0.0.1
  ask LISTEN_PORT "Port for Apache (on 127.0.0.1; people reach it through webdata-gate)" 8080
  [[ $LISTEN_PORT =~ ^[0-9]+$ ]] || die "LISTEN_PORT must be a number"
  ask GATE_PORT "Port for webdata-gate, the front door tailscale serve sends people to" 8081
  [[ $GATE_PORT =~ ^[0-9]+$ && $GATE_PORT != "$LISTEN_PORT" ]] || die "GATE_PORT must be a number other than LISTEN_PORT"
  ask ACCESS_DEFAULT "Databases and reports without a password setting are (public / private)" public
  [[ $ACCESS_DEFAULT =~ ^(public|private)$ ]] || die "ACCESS_DEFAULT must be public or private"
  local site_def="http://127.0.0.1:$GATE_PORT" https
  https=$(tailscale serve status 2>/dev/null | awk '/^https:\/\//{print $1; exit}' || true)
  [[ -n $https ]] && site_def=${https%/}:8443
  ask SITE_URL "The address people open (the HTTPS one tailscale serve gives the gate)" "$site_def"
  ask OMB_DATA_DIR "OpenMausBot's data folder" "$home/.openmausbot"
  ask NODE_MODULES_DIR "Global node_modules with OpenMausBot's native modules" /usr/lib/node_modules
  ask OMB_LOOPBACK_TRUST "Isolate OpenMausBot from local programs, bots included (service / owner / empty)" service
  [[ $OMB_LOOPBACK_TRUST =~ ^(|owner|service)$ ]] || die "OMB_LOOPBACK_TRUST must be service, owner or empty"
  OMB_URL=$(answer_default OMB_URL http://127.0.0.1:8799)
  # The browser's DuckDB-WASM must contain OpenMausBot's DuckDB engine.
  DUCKDB_WASM_VERSION=$(answer_default DUCKDB_WASM_VERSION "")
  if [[ -z $DUCKDB_WASM_VERSION ]]; then
    local api match
    api=$("$NODE" -p "require('$NODE_MODULES_DIR/@duckdb/node-api/package.json').version" 2>/dev/null || true)
    if [[ -n $api ]] && match=$(timeout 180 "$NODE" "$SRC/admin/duckdb-wasm.mjs" match "$api" 2>/dev/null); then
      DUCKDB_WASM_VERSION=$(sed -n 's/^wasm=//p' <<<"$match")
    else
      DUCKDB_WASM_VERSION=$(OMB_WEBREPORTS_CONFIG=/nonexistent "$NODE" --input-type=module -e "console.log((await import('$SRC/bin/_config.mjs')).DUCKDB_WASM_VERSION)")
      warn "couldn't look up the DuckDB-WASM build for @duckdb/node-api ${api:-?}; using $DUCKDB_WASM_VERSION (admin/openmausbot-upgrade.sh --check)"
    fi
  fi
  mkdir -p "$D$CONF_DIR"
  cat > "$D$CONFIG" <<EOF
# omb-webreports settings, written by admin/install.sh (first install).
# Edit as root, then re-run admin/install.sh. Keys: config.example.env in the source.
WEBREPORTS_OWNER=$WEBREPORTS_OWNER
DATA_DIR=$DATA_DIR
PLATFORM_DIR=$PREFIX/webroot
LISTEN_IP=127.0.0.1
LISTEN_PORT=$LISTEN_PORT
GATE_PORT=$GATE_PORT
ACCESS_DEFAULT=$ACCESS_DEFAULT
SITE_URL=$SITE_URL
OMB_DATA_DIR=$OMB_DATA_DIR
NODE_MODULES_DIR=$NODE_MODULES_DIR
OMB_URL=$OMB_URL
OMB_LOOPBACK_TRUST=$OMB_LOOPBACK_TRUST
# Set by admin/openmausbot-upgrade.sh: the DuckDB-WASM build with the same DuckDB as OpenMausBot.
DUCKDB_WASM_VERSION=$DUCKDB_WASM_VERSION
EOF
  chmod 0644 "$D$CONFIG"
  echo "wrote $D$CONFIG"
}

if [[ ! -f $D$CONFIG ]]; then
  (( PRINT )) && die "not installed yet: --print needs $CONFIG (run the install once)"
  first_run_config
fi
if (( ! TEST )); then
  [[ $(stat -c %u "$CONFIG") == 0 ]] && ! (( 8#$(stat -c %a "$CONFIG") & 8#022 )) || die "$CONFIG must be owned by root and writable only by root"
fi
# Root-owned, so it may be read as shell. (Keys only; see config.example.env.)
# shellcheck disable=SC1090
source "$D$CONFIG"
grep -q '^PLATFORM_DIR=' "$D$CONFIG" || echo "PLATFORM_DIR=$PREFIX/webroot" >> "$D$CONFIG"
: "${WEBREPORTS_OWNER:?} ${DATA_DIR:?}"
LISTEN_PORT=${LISTEN_PORT:-8080}
# Older installs had Apache on the tailnet address: it moves behind webdata-gate.
OLD_LISTEN_IP=${LISTEN_IP:-}
if [[ ${LISTEN_IP:-} != 127.0.0.1 ]]; then
  if grep -q '^LISTEN_IP=' "$D$CONFIG"; then sed -i 's/^LISTEN_IP=.*/LISTEN_IP=127.0.0.1/' "$D$CONFIG"; else echo "LISTEN_IP=127.0.0.1" >> "$D$CONFIG"; fi
  [[ -n $OLD_LISTEN_IP ]] && echo "Apache moves from $OLD_LISTEN_IP:$LISTEN_PORT to 127.0.0.1:$LISTEN_PORT, behind webdata-gate (LISTEN_IP in $CONFIG)."
fi
LISTEN_IP=127.0.0.1
grep -q '^GATE_PORT=' "$D$CONFIG" || echo "GATE_PORT=8081" >> "$D$CONFIG"
grep -q '^ACCESS_DEFAULT=' "$D$CONFIG" || echo "ACCESS_DEFAULT=public" >> "$D$CONFIG"
GATE_PORT=${GATE_PORT:-8081}
ACCESS_DEFAULT=${ACCESS_DEFAULT:-public}
[[ $ACCESS_DEFAULT =~ ^(public|private)$ ]] || die "ACCESS_DEFAULT in $CONFIG must be public or private"
[[ $GATE_PORT =~ ^[0-9]+$ && $GATE_PORT != "$LISTEN_PORT" ]] || die "GATE_PORT in $CONFIG must be a number other than LISTEN_PORT"
SITE_URL=${SITE_URL:-http://127.0.0.1:$GATE_PORT}
HOME_DIR=$(getent passwd "$WEBREPORTS_OWNER" | cut -d: -f6)
OMB_DATA_DIR=${OMB_DATA_DIR:-$HOME_DIR/.openmausbot}
NODE_MODULES_DIR=${NODE_MODULES_DIR:-/usr/lib/node_modules}
OMB_URL=${OMB_URL:-http://127.0.0.1:8799}
OMB_LOOPBACK_TRUST=${OMB_LOOPBACK_TRUST:-}
SITE_HOSTNAME=${SITE_HOSTNAME:-}
[[ -z $SITE_HOSTNAME || $SITE_HOSTNAME =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "SITE_HOSTNAME in $CONFIG must be a hostname: lowercase letters, digits and -"
[[ $OMB_LOOPBACK_TRUST =~ ^(|owner|service)$ ]] || die "OMB_LOOPBACK_TRUST in $CONFIG must be service, owner or empty"
OWNER=$WEBREPORTS_OWNER

# --- preflight -------------------------------------------------------------------
node_major=$("$NODE" -p 'process.versions.node.split(".")[0]')
(( node_major >= 20 )) || die "Node.js $node_major is too old; 20+ is required"
if (( ! TEST )); then
  id "$OWNER" >/dev/null 2>&1 || die "user $OWNER does not exist"
  [[ -f $NODE_MODULES_DIR/@duckdb/node-api/package.json ]] || die "$NODE_MODULES_DIR/@duckdb/node-api is missing: OpenMausBot's DuckDB native module (docs/setup.md, step 3)"
  [[ -f $NODE_MODULES_DIR/@resvg/resvg-js/package.json ]] || die "$NODE_MODULES_DIR/@resvg/resvg-js is missing: OpenMausBot's chart-image native module (docs/setup.md, step 3)"
  [[ -d $OMB_DATA_DIR ]] || die "OpenMausBot data dir $OMB_DATA_DIR not found (install and start OpenMausBot first)"
  systemctl cat openmausbot.service >/dev/null 2>&1 || warn "no openmausbot.service: the site works, but bots won't produce data until OpenMausBot runs"
  ls -d "$HOME_DIR"/.agent-browser/browsers/chrome-*/chrome >/dev/null 2>&1 || warn "no Chrome for agent-browser (openmausbot browser install): webdata-check and webdata-browse won't work"
fi
if [[ -e $D$DATA_DIR && $(stat -c %U "$D$DATA_DIR") != "$OWNER" ]] && (( ! TEST )); then
  die "$DATA_DIR exists but isn't owned by $OWNER"
fi

# --- system files, generated into a staging dir ------------------------------------
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
put() { mkdir -p "$STAGE$(dirname "$1")"; cat > "$STAGE$1"; }

# One block per served directory: untrusted content, read-only.
served_dir() {
  cat <<EOF
    <Directory $1>
        # No .htaccess, no symlinks, no CGI/SSI, no content negotiation, no
        # handlers. Listings only for the shared files: elsewhere a listing
        # would name private reports and databases.
        Options ${2:-None}
        AllowOverride None
        AllowOverrideList None
        SetHandler None
        Require all granted
        # Browsers may keep a copy but must revalidate (ETag -> 304) every time,
        # except shared files under /lib requested as ?v=<content hash>: a new
        # version is a new URL, so those are cached for a year.
        Header set Cache-Control "no-cache"
        <If "%{REQUEST_URI} =~ m#^/lib/# && %{QUERY_STRING} =~ /^v=[0-9a-f]{12}\$/">
            Header set Cache-Control "public, max-age=31536000, immutable"
        </If>
    </Directory>
EOF
}

put /etc/apache2/ports.conf <<EOF
# Written by omb-webreports admin/install.sh: Apache is dedicated to this site.
Listen $LISTEN_IP:$LISTEN_PORT
EOF

# zz- prefix: loads after the stock security.conf, so these settings win.
put /etc/apache2/conf-available/zz-reports-hardening.conf <<'EOF'
# Written by omb-webreports admin/install.sh.
ServerName localhost
ServerTokens Prod
ServerSignature Off
TraceEnable Off
FileETag MTime Size

# Deny the filesystem root by default; only explicitly allowed dirs are served.
<Directory />
    Options None
    AllowOverride None
    AllowOverrideList None
    Require all denied
</Directory>
EOF

put /etc/apache2/sites-available/webdata.conf <<EOF
# Written by omb-webreports admin/install.sh from $CONFIG.
<VirtualHost $LISTEN_IP:$LISTEN_PORT>
    # The shared site files (front page, /lib, the gallery) are part of the
    # root-owned program; your reports and the published data are in DATA_DIR.
    # First match wins: the gallery before the rest of /reports.
    DocumentRoot $PREFIX/webroot
    Alias /reports/_gallery $PREFIX/webroot/reports/_gallery
    Alias /reports $DATA_DIR/reports
    Alias /data $DATA_DIR/data

$(served_dir "$PREFIX/webroot" Indexes)
$(served_dir "$DATA_DIR/reports")
$(served_dir "$DATA_DIR/data")

    # Read-only, and only from this machine: people come through webdata-gate
    # (password access), the tools on this machine directly.
    <Location "/">
        <RequireAll>
            Require method GET HEAD
            Require local
        </RequireAll>
    </Location>
    # Never serve dotfiles or dot-dirs.
    <LocationMatch "/\.">
        Require all denied
    </LocationMatch>

    AddType application/octet-stream .duckdb

    # Compression: brotli when the client offers it (browsers do over HTTPS),
    # else gzip. .duckdb snapshots shrink ~30x. NoChange keeps the file's ETag
    # on compressed responses so revalidation still gets 304 (the default
    # suffix breaks If-None-Match). Range requests get identity bytes: a byte
    # range of a compressed stream is useless to DuckDB.
    BrotliCompressionQuality 5
    BrotliAlterETag NoChange
    DeflateAlterETag NoChange
    AddOutputFilterByType BROTLI_COMPRESS;DEFLATE text/html text/plain text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml application/octet-stream
    SetEnvIf Range . no-brotli no-gzip

    IndexOptions FancyIndexing HTMLTable NameWidth=* SuppressDescription FoldersFirst IgnoreCase
    IndexIgnore .??* *~ *#

    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set Referrer-Policy "no-referrer"

    ErrorLog \${APACHE_LOG_DIR}/webdata-error.log
    CustomLog \${APACHE_LOG_DIR}/webdata-access.log combined
</VirtualHost>
EOF

# The front door. Its own system user: the key that signs visitors' cookies is
# in its StateDirectory, which neither the owner (and so bots) nor Apache can
# read. It may read only reports/ (it opens each report.json) and the access
# settings (ACLs below), and talk only to Apache on this machine.
put /etc/systemd/system/webdata-gate.service <<EOF
# Written by omb-webreports admin/install.sh.
[Unit]
Description=omb-webreports gate: password access in front of Apache
After=network.target apache2.service

[Service]
Type=simple
User=$GATE_USER
Group=$GATE_USER
ExecStart=$NODE $PREFIX/bin/webdata-gate
Restart=always
RestartSec=2
StateDirectory=omb-webreports-gate
StateDirectoryMode=0700
# gate.sock: the same door as 127.0.0.1:$GATE_PORT, for the site's own Tailscale node.
RuntimeDirectory=omb-webreports-gate
RuntimeDirectoryMode=0755
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF

# The site's own Tailscale node (SITE_HOSTNAME; `webdata-admin site login` starts
# it): a second tailscaled in userspace mode, as its own user, so the site gets
# https://<SITE_HOSTNAME>.<tailnet>.ts.net/ and Funnel opens only the site.
# In userspace mode tailscaled hands a tailnet peer's connection to any port it
# doesn't serve to 127.0.0.1 on that port, which would let peers past the gate
# to Apache (private databases) and to OpenMausBot as a local caller. So it may
# not reach loopback at all (IPAddressDeny), and serves the gate's Unix socket.
# That also shuts out systemd-resolved's 127.0.0.53, so it gets the real servers.
TAILSCALED=$(command -v tailscaled || echo /usr/sbin/tailscaled)
resolv=""
if grep -Eq '^nameserver[[:space:]]+(127\.|::1)' /etc/resolv.conf 2>/dev/null && [[ -f /run/systemd/resolve/resolv.conf ]]; then
  resolv="BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
fi
put /etc/systemd/system/webdata-tailscale.service <<EOF
# Written by omb-webreports admin/install.sh. Started by: sudo webdata-admin site login <name>
[Unit]
Description=omb-webreports: the site's own Tailscale node (SITE_HOSTNAME in $CONFIG)
Wants=network-online.target
After=network-online.target systemd-resolved.service webdata-gate.service

[Service]
Type=notify
User=$TS_USER
Group=$TS_USER
ExecStart=$TAILSCALED --tun=userspace-networking --statedir=/var/lib/$TS_USER --socket=$TS_SOCKET --port=0
Restart=on-failure
RestartSec=5
StateDirectory=$TS_USER
StateDirectoryMode=0700
RuntimeDirectory=$TS_USER
RuntimeDirectoryMode=0755
UMask=0077
# In userspace mode tailscaled passes a tailnet peer's connection to a port it
# doesn't serve on to 127.0.0.1 on that port: past the gate. So no loopback at
# all; it reaches the gate by the gate's socket.
IPAddressDeny=localhost
$resolv
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF

# Both services run the root-owned program as the owner, and may write only DATA_DIR
# (jobs also the bots' database folders).
put /etc/systemd/system/webdata-sync.service <<EOF
# Written by omb-webreports admin/install.sh.
[Unit]
Description=omb-webreports sync: bot database snapshots, data catalog, report index
After=network.target openmausbot.service

[Service]
Type=simple
User=$OWNER
Group=$OWNER
Environment=HOME=$HOME_DIR
ExecStart=$NODE $PREFIX/bin/webdata-sync --watch
Restart=always
RestartSec=5
Nice=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
# ProtectSystem does not cover /home; without this the whole home dir is writable.
ProtectHome=read-only
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

put /etc/systemd/system/webdata-jobs.service <<EOF
# Written by omb-webreports admin/install.sh.
[Unit]
Description=omb-webreports jobs: scheduled scripts that refresh bots' DuckDB tables
After=network-online.target openmausbot.service
Wants=network-online.target

[Service]
Type=simple
User=$OWNER
Group=$OWNER
Environment=HOME=$HOME_DIR
ExecStart=$NODE $PREFIX/bin/webdata-job daemon
Restart=always
RestartSec=5
Nice=10
KillMode=mixed
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR $OMB_DATA_DIR/bots

[Install]
WantedBy=multi-user.target
EOF

# Failure alerts. Root, because it holds the webhooks' secrets (in its own
# StateDirectory, which bots can't read) and uses the OpenMausBot admin session.
# It reads the jobs' files only through a child it runs as the owner, and treats
# them as data. Everything else is locked down: read-only system, no home dirs,
# localhost only (OpenMausBot), and just the capabilities to switch to the owner.
put /etc/systemd/system/webdata-notify.service <<EOF
# Written by omb-webreports admin/install.sh.
[Unit]
Description=omb-webreports notify: alerts a bot when a scheduled data job keeps failing
After=network.target openmausbot.service

[Service]
Type=simple
ExecStart=$NODE $PREFIX/bin/webdata-notify daemon
Restart=always
RestartSec=10
Nice=10
StateDirectory=omb-webreports-notify
StateDirectoryMode=0755
UMask=0022
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_SETUID CAP_SETGID
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
SystemCallArchitectures=native
SystemCallFilter=@system-service @setuid
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF

# OpenMausBot isolation (OMB_LOOPBACK_TRUST). With "service", OpenMausBot ignores
# requests from this machine that have no login, so bots' shells can't
# administer it. webdata-skills signs in with its own session (root-only, in
# /etc/omb-webreports), which the timer keeps valid, running the root-owned program.
if [[ -n $OMB_LOOPBACK_TRUST ]]; then
put "$LOOPBACK_DROPIN" <<EOF
# Written by omb-webreports admin/install.sh (OMB_LOOPBACK_TRUST in $CONFIG).
[Service]
Environment=OMB_LOOPBACK_TRUST=$OMB_LOOPBACK_TRUST
EOF
fi
if [[ $OMB_LOOPBACK_TRUST == service ]]; then
put /etc/systemd/system/webdata-omb-session.service <<EOF
# Written by omb-webreports admin/install.sh.
[Unit]
Description=omb-webreports: keep webdata-skills' OpenMausBot session valid
After=openmausbot.service network-online.target

[Service]
Type=oneshot
ExecStart=$NODE $PREFIX/bin/webdata-skills keepalive
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$CONF_DIR
EOF
put /etc/systemd/system/webdata-omb-session.timer <<'EOF'
# Written by omb-webreports admin/install.sh.
[Unit]
Description=omb-webreports: renew webdata-skills' OpenMausBot session daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
fi

if (( PRINT )); then
  echo "# omb-webreports install --print: SRC=$SRC PREFIX=$PREFIX DATA_DIR=$DATA_DIR OWNER=$OWNER LISTEN=$LISTEN_IP:$LISTEN_PORT SITE=$SITE_URL"
  (cd "$STAGE" && find . -type f | sort | while read -r f; do echo; echo "======== ${f#.}"; cat "$f"; done)
  echo; echo "======== also: the program copied to $PREFIX; $DATA_DIR for $OWNER (www-data may read reports/ and data/); /usr/local/bin symlinks: ${TOOLS[*]}"
  exit 0
fi

# --- packages --------------------------------------------------------------------
(( TEST )) || apt-get install -y -qq apache2 acl >/dev/null
for u in "$GATE_USER" "$TS_USER"; do
  if (( ! TEST )) && ! id "$u" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$u"
  fi
done

# --- the program: a root-owned copy of just what runs and what agents read --------
PROGRAM_DIRS=(bin skills templates examples docs webroot/lib webroot/reports/_gallery)
PROGRAM_FILES=(README.md LICENSE THIRD_PARTY.md READ_FIRST.md DESIGN.md CLAUDE.md AGENTS.md config.example.env
  webroot/index.html webroot/report.json webroot/icon.svg)
new=$D$PREFIX.new
rm -rf "$new"
for p in "${PROGRAM_DIRS[@]}" "${PROGRAM_FILES[@]}"; do
  [[ -e $SRC/$p ]] || die "missing in the source: $p"
  # Only the two known symlinks: a link could point the copy at anything.
  while IFS= read -r l; do
    [[ $l == "$SRC/CLAUDE.md" || $l == "$SRC/AGENTS.md" ]] || die "unexpected symlink in the source: $l"
  done < <(find "$SRC/$p" -type l)
  mkdir -p "$new/$(dirname "$p")"
  cp -R -P --no-preserve=ownership "$SRC/$p" "$new/$p"
done
if (( ! TEST )); then chown -R root:root "$new"; fi
chmod -R u=rwX,go=rX "$new"
chmod 0755 "$new"/bin/*
if [[ -d $D$PREFIX ]]; then rm -rf "$D$PREFIX.old"; mv "$D$PREFIX" "$D$PREFIX.old"; fi
mkdir -p "$(dirname "$D$PREFIX")"
mv "$new" "$D$PREFIX"
rm -rf "$D$PREFIX.old"
# The shared pages get their versioned module block and the front page its app
# icons here, as root: they only change when the program does.
OMB_WEBREPORTS_CONFIG=$D$CONFIG PLATFORM_DIR=$D$PREFIX/webroot "$NODE" "$D$PREFIX/bin/webdata-sync" --platform | sed 's/^/  /'

# --- DATA_DIR: the owner's; Apache may read only reports/ and data/ -----------------
mkdir -p "$D$DATA_DIR"
if (( ! TEST )); then chown "$OWNER:$OWNER" "$D$DATA_DIR"; chmod 0750 "$D$DATA_DIR"; fi
asowner mkdir -p "$D$DATA_DIR/reports" "$D$DATA_DIR/data" "$D$DATA_DIR/jobs" "$D$DATA_DIR/.state" "$D$DATA_DIR/access"

if [[ -n $MIGRATE ]]; then
  echo "migrating content from $MIGRATE (as $OWNER):"
  for d in "$MIGRATE"/webroot/reports/*/; do
    slug=$(basename "$d"); [[ $slug == _* || -e $D$DATA_DIR/reports/$slug ]] && continue
    asowner cp -a "$d" "$D$DATA_DIR/reports/$slug" && echo "  report $slug"
  done
  for d in "$MIGRATE"/jobs/*/; do
    [[ -d $d ]] || continue; name=$(basename "$d"); [[ -e $D$DATA_DIR/jobs/$name ]] && continue
    asowner cp -a "$d" "$D$DATA_DIR/jobs/$name" && echo "  job $name"
  done
  for f in sync.json; do
    [[ -f $MIGRATE/$f && ! -e $D$DATA_DIR/$f ]] && asowner cp -a "$MIGRATE/$f" "$D$DATA_DIR/$f" && echo "  $f"
  done
  [[ -d $MIGRATE/.state/jobs && ! -e $D$DATA_DIR/.state/jobs ]] && asowner cp -a "$MIGRATE/.state/jobs" "$D$DATA_DIR/.state/jobs" && echo "  job history"
fi

if (( ! TEST )); then
  setfacl -m u:www-data:x "$DATA_DIR"
  dir=$(dirname "$DATA_DIR")
  while [[ $dir != / ]]; do
    runuser -u www-data -- test -x "$dir" || setfacl -m u:www-data:x "$dir"
    dir=$(dirname "$dir")
  done
  # As the owner, never following links: these trees are the owner's (and bots') to fill.
  runuser -u "$OWNER" -- setfacl -R -P -m u:www-data:rX "$DATA_DIR/reports" "$DATA_DIR/data"
  runuser -u "$OWNER" -- setfacl -R -P -d -m u:www-data:rX "$DATA_DIR/reports" "$DATA_DIR/data"
  # The gate reads the reports' report.json and the access settings, nothing else.
  setfacl -m "u:$GATE_USER:x" "$DATA_DIR"
  dir=$(dirname "$DATA_DIR")
  while [[ $dir != / ]]; do
    runuser -u "$GATE_USER" -- test -x "$dir" || setfacl -m "u:$GATE_USER:x" "$dir"
    dir=$(dirname "$dir")
  done
  runuser -u "$OWNER" -- setfacl -R -P -m "u:$GATE_USER:rX" "$DATA_DIR/reports" "$DATA_DIR/access"
  runuser -u "$OWNER" -- setfacl -R -P -d -m "u:$GATE_USER:rX" "$DATA_DIR/reports" "$DATA_DIR/access"
  if [[ -n $MIGRATE ]]; then
    # The old layout let www-data through the folders above the old checkout.
    dir=$MIGRATE
    while [[ $dir != / ]]; do
      [[ $DATA_DIR == "$dir"/* ]] || setfacl -x u:www-data "$dir" 2>/dev/null || true
      dir=$(dirname "$dir")
    done
  fi
fi

# --- remove what older versions installed -------------------------------------------
if (( ! TEST )); then
  if [[ -e /etc/systemd/system/webdata-config.path ]]; then
    systemctl disable --now -q webdata-config.path webdata-config.service 2>/dev/null || true
    rm -f /etc/systemd/system/webdata-config.path /etc/systemd/system/webdata-config.service
  fi
  rm -f /usr/local/sbin/webdata-apply-config /usr/local/bin/new-report
  # Apache no longer binds the tailnet address, so it needn't wait for Tailscale.
  rm -f /etc/systemd/system/apache2.service.d/tailscale.conf
  rmdir /etc/systemd/system/apache2.service.d 2>/dev/null || true
  rm -rf /etc/apache2/webdata /run/webdata
  a2dissite -q reports 2>/dev/null || true
  rm -f /etc/apache2/sites-available/reports.conf
fi

# --- install the generated system files ---------------------------------------------
dropin_before=$(cat "$D$LOOPBACK_DROPIN" 2>/dev/null || true)
(cd "$STAGE" && find . -type f) | while read -r f; do
  install -D -m 0644 "$STAGE/${f#./}" "$D/${f#./}"
done

# --- tools on PATH -------------------------------------------------------------------
mkdir -p "$D/usr/local/bin"
for t in "${TOOLS[@]}"; do ln -sfn "$PREFIX/bin/$t" "$D/usr/local/bin/$t"; done

# --- where this install came from -------------------------------------------------------
src_owner=$(stat -c %U "$SRC")
commit="" ref=""
if [[ -d $SRC/.git ]]; then
  # Never run git as root in a repository someone else can write (its config can run code).
  gitas() { if [[ $src_owner == root ]] || (( TEST )); then git -C "$SRC" "$@"; else runuser -u "$src_owner" -- git -C "$SRC" "$@"; fi; }
  commit=$(gitas rev-parse --verify -q HEAD 2>/dev/null || true)
  ref=$(gitas describe --tags --exact-match 2>/dev/null || gitas symbolic-ref --short -q HEAD 2>/dev/null || true)
  [[ -n $commit ]] && [[ -n $(gitas status --porcelain 2>/dev/null) ]] && ref="${ref:+$ref, }with uncommitted changes"
fi
SOURCE=$SRC COMMIT=$commit REF=$ref UNSAFE_INSTALL=$UNSAFE SRC_OWNER=$src_owner "$NODE" -e '
  const e = process.env;
  process.stdout.write(JSON.stringify({ source: e.SOURCE, commit: e.COMMIT || null, ref: e.REF || null,
    unsafe: e.UNSAFE_INSTALL === "1", source_owner: e.SRC_OWNER, at: new Date().toISOString() }, null, 2) + "\n");
' > "$D$CONF_DIR/installed.json"
chmod 0644 "$D$CONF_DIR/installed.json"
(( TEST )) || logger -t omb-webreports "installed from $SRC${commit:+ @ $commit}${ref:+ ($ref)}$( (( UNSAFE )) && echo ' UNSAFE development checkout')" 2>/dev/null || true

if (( TEST )); then
  echo "test install written under $D (nothing outside it was changed)"
  exit 0
fi

# --- Apache modules and sites ------------------------------------------------------------
a2enmod -q headers autoindex filter deflate brotli setenvif alias
a2dismod -q -f status cgi cgid include negotiation userdir 2>/dev/null || true
a2dissite -q 000-default default-ssl 2>/dev/null || true
a2enconf -q zz-reports-hardening
a2ensite -q webdata
apache2ctl configtest

# --- services ----------------------------------------------------------------------------
systemctl daemon-reload
systemctl enable -q apache2 webdata-gate.service webdata-sync.service webdata-jobs.service webdata-notify.service
systemctl restart apache2 webdata-gate.service webdata-sync.service webdata-jobs.service
# The site's own Tailscale node, once it has been set up (webdata-admin site login);
# restarted so it runs the tailscaled that's installed now.
if [[ -n $SITE_HOSTNAME ]]; then
  systemctl enable -q webdata-tailscale.service
  systemctl restart webdata-tailscale.service
fi

# --- tailscale serve: people go to the gate, never straight to Apache -----------------
# Older installs pointed tailscale serve (and maybe Funnel) at Apache's tailnet
# address, which Apache no longer listens on. Repoint those handlers at the gate,
# keeping Funnel on wherever it was on.
if command -v tailscale >/dev/null 2>&1 && st=$(tailscale serve status --json 2>/dev/null); then
  while IFS=' ' read -r port funnel; do
    [[ -n $port ]] || continue
    if [[ $funnel == 1 ]]; then tailscale funnel --bg --https="$port" "http://127.0.0.1:$GATE_PORT" >/dev/null
    else tailscale serve --bg --https="$port" "http://127.0.0.1:$GATE_PORT" >/dev/null; fi
    echo "tailscale: https port $port now goes to webdata-gate (127.0.0.1:$GATE_PORT)$( [[ $funnel == 1 ]] && echo ', Funnel kept on')"
  done < <(OLD="${OLD_LISTEN_IP:-127.0.0.1}" PORT="$LISTEN_PORT" "$NODE" -e '
    const st = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
    const apache = new Set([`http://${process.env.OLD}:${process.env.PORT}`, `http://127.0.0.1:${process.env.PORT}`, `http://localhost:${process.env.PORT}`]);
    for (const [host, w] of Object.entries(st.Web || {})) {
      const p = w?.Handlers?.["/"]?.Proxy?.replace(/\/$/, "");
      if (apache.has(p)) console.log(host.split(":").pop(), st.AllowFunnel?.[host] ? 1 : 0);
    }' <<<"$st")
fi

# --- OpenMausBot isolation ---------------------------------------------------------------
omb_up() { for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 2 "$OMB_URL/api/health" && return 0; sleep 1; done; return 1; }
if systemctl cat openmausbot.service >/dev/null 2>&1; then
  [[ -n $OMB_LOOPBACK_TRUST ]] || rm -f "$LOOPBACK_DROPIN"
  dropin_after=$(cat "$LOOPBACK_DROPIN" 2>/dev/null || true)
  echo
  echo "OpenMausBot local requests: ${OMB_LOOPBACK_TRUST:-the OpenMausBot default}"
  if [[ $OMB_LOOPBACK_TRUST == service ]]; then
    # webdata-skills' own session first: while OpenMausBot still trusts local
    # requests (before the restart below), it mints the pairing code itself.
    omb_up && "$NODE" "$PREFIX/bin/webdata-skills" login 2>&1 | sed 's/^/  /' \
      || warn "webdata-skills has no OpenMausBot session: create a full-access pairing code in the app (Settings → Remote access), then: sudo webdata-admin skills login --code <code>"
  fi
  if [[ $dropin_before != "$dropin_after" ]]; then
    systemctl daemon-reload
    echo "  restarting openmausbot for the change"
    systemctl restart openmausbot.service
    omb_up || warn "openmausbot didn't come back at $OMB_URL; check: journalctl -u openmausbot -n 50"
  fi
  if [[ $OMB_LOOPBACK_TRUST == service ]]; then
    systemctl enable -q --now webdata-omb-session.timer
    code=$(curl -s -o /dev/null -w '%{http_code}' "$OMB_URL/api/bot-presets" || true)
    if [[ $code == 401 || $code == 403 ]]; then echo "  isolated: a local request without a login is refused ($code)"
    else warn "isolation check: OpenMausBot answered $code to a local request without a login (expected 403)"; fi
  else
    systemctl disable -q --now webdata-omb-session.timer 2>/dev/null || true
    rm -f /etc/systemd/system/webdata-omb-session.service /etc/systemd/system/webdata-omb-session.timer
    systemctl daemon-reload
  fi
fi

# Failure alerts use the session above, so they start after it.
systemctl restart webdata-notify.service
if [[ -f $DATA_DIR/jobs/.notify.env ]]; then
  warn "$DATA_DIR/jobs/.notify.env is no longer used (bots could read it): failure alerts now come from webdata-notify. Add \"notify_failure\": \"<bot>\" to each job.json, delete the file, and remove those webhooks in OpenMausBot."
fi

# --- bots' skills ------------------------------------------------------------------------
# Bots keep their own copy of each skill: bring the copies (and the Report builder
# preset) up to date. As root, with the root-only session when OpenMausBot is
# isolated; a failure here doesn't fail the install.
if systemctl is-active --quiet openmausbot.service; then
  echo
  echo "bots' skills (webdata-skills sync):"
  "$NODE" "$PREFIX/bin/webdata-skills" sync 2>&1 | sed 's/^/  /' \
    || warn "couldn't update the bots' skills; run: sudo webdata-admin skills sync"
fi

echo
echo "omb-webreports is installed$( (( UNSAFE )) && echo ' (UNSAFE: from a development checkout)')."
echo "  program  $PREFIX  (from $SRC${commit:+ @ ${commit:0:12}})"
echo "  content  $DATA_DIR"
echo "  on       $SITE_URL  (webdata-gate on 127.0.0.1:$GATE_PORT; Apache on 127.0.0.1:$LISTEN_PORT; unset databases are $ACCESS_DEFAULT)"
echo "  check    webdata-info; as root: sudo webdata-admin status"
if [[ -n $MIGRATE ]]; then
  echo "  migrated from $MIGRATE: once the site looks right, delete that folder (its services now run from $PREFIX)"
fi
if [[ -n $SITE_HOSTNAME ]]; then
  echo "  node     the site's own Tailscale node, $SITE_HOSTNAME: sudo webdata-admin site status"
else
  if [[ $SITE_URL == https://*.ts.net:* ]] && ! tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$GATE_PORT"; then
    echo "  HTTPS    not set up yet: tailscale serve --bg --https=${SITE_URL##*:} http://127.0.0.1:$GATE_PORT"
  fi
  echo "  address  for https://<name>.<tailnet>.ts.net/ (its own Tailscale node): sudo webdata-admin site login <name>"
fi
echo "  internet to open the site to everyone (set passwords first: webdata-access status):"
echo "           sudo webdata-admin site funnel on"

