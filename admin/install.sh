#!/usr/bin/env bash
# omb-webreports installer: the system side (Apache, systemd units, tools on
# PATH). Idempotent: re-run after pulling changes or editing config.env.
#
#   sudo bash admin/install.sh           install / update
#   sudo bash admin/install.sh --print   show every file it would write; change nothing
#
# Reads ../config.env (see config.example.env). Sets up:
#   - Apache, dedicated to this site: listens only on LISTEN_IP:LISTEN_PORT,
#     serves webroot/ read-only and hardened, GET/HEAD only, from ALLOWED_NETS
#   - webdata-sync.service: publishes bot databases, catalog, report index
#   - webdata-jobs.service: runs scheduled data jobs (jobs/*)
#   - /usr/local/bin/webdata-* symlinks to the tools in bin/
# Everything else (reports, jobs, docs) needs no root.
set -euo pipefail

HERE=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
DOCROOT=$ROOT/webroot
PRINT=0
[[ ${1:-} == --print ]] && PRINT=1

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

[[ $EUID -eq 0 || $PRINT -eq 1 ]] || die "run as root: sudo bash $0"

# --- configuration ------------------------------------------------------------
[[ -f $ROOT/config.env ]] || die "no $ROOT/config.env. Create it: cp config.example.env config.env (then edit)"
# shellcheck disable=SC1091
source "$ROOT/config.env"

OWNER=${WEBREPORTS_OWNER:-${SUDO_USER:-}}
[[ -n $OWNER && $OWNER != root ]] || die "set WEBREPORTS_OWNER in config.env (the user that runs OpenMausBot)"
id "$OWNER" >/dev/null 2>&1 || die "user $OWNER does not exist"
HOME_DIR=$(getent passwd "$OWNER" | cut -d: -f6)
LISTEN_IP=${LISTEN_IP:-$(tailscale ip -4 2>/dev/null | head -1 || true)}
[[ -n $LISTEN_IP ]] || die "set LISTEN_IP in config.env (Tailscale not found to pick a default)"
LISTEN_PORT=${LISTEN_PORT:-8080}
ALLOWED_NETS=${ALLOWED_NETS:-"100.64.0.0/10 fd7a:115c:a1e0::/48"}
SITE_URL=${SITE_URL:-http://$LISTEN_IP:$LISTEN_PORT}
OMB_DATA_DIR=${OMB_DATA_DIR:-$HOME_DIR/.openmausbot}
NODE_MODULES_DIR=${NODE_MODULES_DIR:-/usr/lib/node_modules}
NODE=$(command -v node || true)
OMB_LOOPBACK_TRUST=${OMB_LOOPBACK_TRUST:-}
[[ $OMB_LOOPBACK_TRUST =~ ^(|owner|service)$ ]] || die "OMB_LOOPBACK_TRUST in config.env must be service, owner or empty"
OMB_URL=${OMB_URL:-http://127.0.0.1:8799}
LOOPBACK_DROPIN=/etc/systemd/system/openmausbot.service.d/omb-webreports-loopback.conf
TOOLS=(webdata-info webdata-ls webdata-sql webdata-check webdata-new-report webdata-job webdata-browse webdata-errors webdata-sync webdata-bake webdata-skills)

# --- preflight ----------------------------------------------------------------
[[ -n $NODE ]] || die "node not found (Node.js 20+ is required; see docs/setup.md)"
node_major=$("$NODE" -p 'process.versions.node.split(".")[0]')
(( node_major >= 20 )) || die "Node.js $node_major is too old; 20+ is required"
[[ -f $NODE_MODULES_DIR/@duckdb/node-api/package.json ]] || die "$NODE_MODULES_DIR/@duckdb/node-api is missing: OpenMausBot's DuckDB native module (docs/setup.md, step 3)"
[[ -f $NODE_MODULES_DIR/@resvg/resvg-js/package.json ]] || die "$NODE_MODULES_DIR/@resvg/resvg-js is missing: OpenMausBot's chart-image native module (docs/setup.md, step 3)"
[[ -d $OMB_DATA_DIR ]] || die "OpenMausBot data dir $OMB_DATA_DIR not found (install and start OpenMausBot first)"
[[ $(stat -c %U "$ROOT") == "$OWNER" ]] || die "$ROOT must be owned by $OWNER"
systemctl cat openmausbot.service >/dev/null 2>&1 || warn "no openmausbot.service: the site works, but bots won't produce data until OpenMausBot runs"
ls -d "$HOME_DIR"/.agent-browser/browsers/chrome-*/chrome >/dev/null 2>&1 || warn "no Chrome for agent-browser (openmausbot browser install): webdata-check and webdata-browse won't work"
# The browser's DuckDB (DUCKDB_WASM_VERSION) should contain the same engine as
# OpenMausBot's @duckdb/node-api. admin/openmausbot-upgrade.sh keeps them equal;
# this only warns (as the owner, sharing their lookup cache).
if (( ! PRINT )); then
  api=$("$NODE" -p "require('$NODE_MODULES_DIR/@duckdb/node-api/package.json').version")
  wasm=$(runuser -u "$OWNER" -- "$NODE" --input-type=module -e "console.log((await import('$ROOT/bin/_config.mjs')).DUCKDB_WASM_VERSION)" 2>/dev/null || true)
  if match=$(timeout 180 runuser -u "$OWNER" -- "$NODE" "$ROOT/admin/duckdb-wasm.mjs" match "$api" 2>/dev/null); then
    want=$(sed -n 's/^wasm=//p' <<<"$match")
    [[ $want == "$wasm" ]] || warn "browser DuckDB-WASM $wasm differs from the build matching OpenMausBot's DuckDB ($want for @duckdb/node-api $api): run admin/openmausbot-upgrade.sh (as $OWNER) to align them"
  else
    warn "couldn't confirm the browser's DuckDB-WASM $wasm matches OpenMausBot's DuckDB (@duckdb/node-api $api); check with: admin/openmausbot-upgrade.sh --check"
  fi
fi

# --- generate every file into a staging dir -----------------------------------
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
put() { mkdir -p "$STAGE$(dirname "$1")"; cat > "$STAGE$1"; }

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
# Written by omb-webreports admin/install.sh from config.env.
<VirtualHost $LISTEN_IP:$LISTEN_PORT>
    DocumentRoot $DOCROOT

    <Directory $DOCROOT>
        # Untrusted content: no .htaccess, no symlinks, no CGI/SSI, no content
        # negotiation, no handlers. Indexes on so the tree can be browsed.
        Options Indexes
        AllowOverride None
        AllowOverrideList None
        SetHandler None
        Require all granted

        # Browsers may keep a copy but must revalidate (ETag -> 304) every
        # time, so a changed file is picked up.
        Header set Cache-Control "no-cache"
        # Except shared files under /lib requested as ?v=<content hash>:
        # webdata-sync stamps those URLs into pages, and a new version is a new
        # URL, so they are cached for a year without revalidating. Moving
        # between reports then fetches no shared code at all.
        <If "%{REQUEST_URI} =~ m#^/lib/# && %{QUERY_STRING} =~ /^v=[0-9a-f]{12}\$/">
            Header set Cache-Control "public, max-age=31536000, immutable"
        </If>
    </Directory>

    # Read-only, and only from the allowed networks.
    <Location "/">
        <RequireAll>
            Require method GET HEAD
            Require ip $ALLOWED_NETS
        </RequireAll>
    </Location>
    # Never serve dotfiles or dot-dirs (.git, .env, .state, ...).
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

# Apache binds to LISTEN_IP, which (with Tailscale) may not exist yet at boot.
put /etc/systemd/system/apache2.service.d/tailscale.conf <<'EOF'
# Written by omb-webreports admin/install.sh.
[Unit]
After=tailscaled.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Restart=on-failure
RestartSec=5
EOF

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
ExecStart=$NODE $ROOT/bin/webdata-sync --watch
Restart=always
RestartSec=5
Nice=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
# ProtectSystem does not cover /home; without this the whole home dir is writable.
ProtectHome=read-only
ReadWritePaths=$ROOT

[Install]
WantedBy=multi-user.target
EOF

# Job scripts inherit this sandbox: they may write the checkout and the bots'
# database folders, nothing else in home.
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
ExecStart=$NODE $ROOT/bin/webdata-job daemon
Restart=always
RestartSec=5
Nice=10
KillMode=mixed
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
# ProtectSystem does not cover /home; without this the whole home dir is writable.
ProtectHome=read-only
ReadWritePaths=$ROOT $OMB_DATA_DIR/bots

[Install]
WantedBy=multi-user.target
EOF

# OpenMausBot isolation (OMB_LOOPBACK_TRUST in config.env). With "service",
# OpenMausBot ignores requests from this machine that have no login, so bots'
# shells (which run here) can't administer it through its local API.
# webdata-skills then signs in with its own session, kept root-only in
# /etc/omb-webreports, and the timer keeps that session valid.
if [[ -n $OMB_LOOPBACK_TRUST ]]; then
put "$LOOPBACK_DROPIN" <<EOF
# Written by omb-webreports admin/install.sh (OMB_LOOPBACK_TRUST in config.env).
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
ExecStart=$NODE $ROOT/bin/webdata-skills keepalive
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/etc/omb-webreports
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
  echo "# omb-webreports install --print: ROOT=$ROOT OWNER=$OWNER LISTEN=$LISTEN_IP:$LISTEN_PORT SITE=$SITE_URL"
  (cd "$STAGE" && find . -type f | sort | while read -r f; do echo; echo "======== ${f#.}"; cat "$f"; done)
  echo; echo "======== also: ACLs for www-data on $DOCROOT and its parent dirs; /usr/local/bin symlinks: ${TOOLS[*]}"
  exit 0
fi

# --- packages -----------------------------------------------------------------
apt-get install -y -qq apache2 acl >/dev/null

# --- filesystem access --------------------------------------------------------
# www-data: traverse-only on each parent directory it can't already pass
# through (it cannot list or read them), read-only on webroot, incl. new files.
install -d -o "$OWNER" -g "$OWNER" -m 0755 "$DOCROOT" "$ROOT/jobs"
dir=$(dirname "$DOCROOT")
while [[ $dir != / ]]; do
  runuser -u www-data -- test -x "$dir" || setfacl -m u:www-data:x "$dir"
  dir=$(dirname "$dir")
done
setfacl -R -m u:www-data:rX "$DOCROOT"
setfacl -R -d -m u:www-data:rX "$DOCROOT"

# --- remove what older versions installed ------------------------------------
# (the configs/ Apache-override feature was removed)
if [[ -e /etc/systemd/system/webdata-config.path ]]; then
  systemctl disable --now -q webdata-config.path webdata-config.service 2>/dev/null || true
  rm -f /etc/systemd/system/webdata-config.path /etc/systemd/system/webdata-config.service
fi
rm -f /usr/local/sbin/webdata-apply-config /usr/local/bin/new-report
rm -rf /etc/apache2/webdata /run/webdata
a2dissite -q reports 2>/dev/null || true
rm -f /etc/apache2/sites-available/reports.conf

# --- install the generated files ---------------------------------------------
dropin_before=$(cat "$LOOPBACK_DROPIN" 2>/dev/null || true)
(cd "$STAGE" && find . -type f) | while read -r f; do
  install -D -m 0644 "$STAGE/${f#./}" "/${f#./}"
done

# --- tools on PATH ------------------------------------------------------------
for t in "${TOOLS[@]}"; do
  chmod 0755 "$ROOT/bin/$t"
  ln -sfn "$ROOT/bin/$t" "/usr/local/bin/$t"
done

# --- Apache modules and sites --------------------------------------------------
a2enmod -q headers autoindex filter deflate brotli setenvif
a2dismod -q -f status cgi cgid include negotiation userdir 2>/dev/null || true
a2dissite -q 000-default default-ssl 2>/dev/null || true
a2enconf -q zz-reports-hardening
a2ensite -q webdata
apache2ctl configtest

# --- services -------------------------------------------------------------------
systemctl daemon-reload
systemctl enable -q apache2 webdata-sync.service webdata-jobs.service
systemctl restart apache2 webdata-sync.service webdata-jobs.service

# --- OpenMausBot isolation ------------------------------------------------------
omb_up() { for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 2 "$OMB_URL/api/health" && return 0; sleep 1; done; return 1; }
if systemctl cat openmausbot.service >/dev/null 2>&1; then
  [[ -n $OMB_LOOPBACK_TRUST ]] || rm -f "$LOOPBACK_DROPIN"
  dropin_after=$(cat "$LOOPBACK_DROPIN" 2>/dev/null || true)
  echo
  echo "OpenMausBot local requests: ${OMB_LOOPBACK_TRUST:-the OpenMausBot default}"
  if [[ $OMB_LOOPBACK_TRUST == service ]]; then
    # webdata-skills' own session first: while OpenMausBot still trusts local
    # requests (before the restart below), it mints the pairing code itself.
    omb_up && "$NODE" "$ROOT/bin/webdata-skills" login 2>&1 | sed 's/^/  /' \
      || warn "webdata-skills has no OpenMausBot session: create a full-access pairing code in the app (Settings → Remote access), then: sudo webdata-skills login --code <code>"
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

# --- bots' skills ---------------------------------------------------------------
# Bots keep their own copy of each skill: after a git pull, bring the copies
# (and the Report builder preset) up to date through OpenMausBot's API. As
# root, so it can use the root-only session when OpenMausBot is isolated; a
# failure here doesn't fail the install.
if systemctl is-active --quiet openmausbot.service; then
  echo
  echo "bots' skills (webdata-skills sync):"
  "$NODE" "$ROOT/bin/webdata-skills" sync 2>&1 | sed 's/^/  /' \
    || warn "couldn't update the bots' skills; run: sudo webdata-skills sync"
fi

echo
echo "omb-webreports is installed."
echo "  serving  $DOCROOT"
echo "  on       http://$LISTEN_IP:$LISTEN_PORT/  (site URL: $SITE_URL)"
echo "  check    webdata-info"
if [[ $SITE_URL == https://*.ts.net:* ]] && ! tailscale serve status 2>/dev/null | grep -q "$LISTEN_IP:$LISTEN_PORT"; then
  echo "  HTTPS    not set up yet: tailscale serve --bg --https=${SITE_URL##*:} http://$LISTEN_IP:$LISTEN_PORT"
fi
