#!/usr/bin/env bash
# webdata-admin site: the site's address, and whether the internet can reach it.
# Run by webdata-admin (as root); see its usage.
#
# The site's own Tailscale node (SITE_HOSTNAME in config.env) gives it
# https://<name>.<tailnet>.ts.net/ instead of the machine's
# https://<machine>.<tailnet>.ts.net:8443, and Funnel on it opens only the site,
# never what else the machine serves (OpenMausBot). It's a second tailscaled
# (webdata-tailscale.service, written by admin/install.sh) in userspace mode, as
# its own user, with no access to this machine's loopback; it serves the gate
# through the gate's Unix socket. Without a node of its own, `funnel` works on
# the machine's tailscale serve port in SITE_URL.
set -euo pipefail

BIN=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
NODE=$(command -v node || echo /usr/bin/node)
CONFIG=${OMB_WEBREPORTS_CONFIG:-/etc/omb-webreports/config.env}
UNIT=webdata-tailscale.service
TS_USER=omb-webreports-tailscale

die() { echo "error: $*" >&2; exit 1; }
conf() { "$NODE" --input-type=module -e "const c = await import('$BIN/_config.mjs'); console.log(c[process.argv[1]])" "$1"; }
GATE_SOCKET=$(conf GATE_SOCKET)
GATE_PORT=$(conf GATE_PORT)
TS_SOCKET=$(conf SITE_TS_SOCKET)
SITE_HOSTNAME=$(conf SITE_HOSTNAME)
SITE_URL=$(conf SITE_URL)

# The site node's CLI, as the node's own user (full rights on its own daemon).
ts() { runuser -u "$TS_USER" -- tailscale --socket="$TS_SOCKET" "$@"; }
# A field of `tailscale status --json` / `serve status --json` (JavaScript expression over `s`).
jq_() { "$NODE" -e 'const s = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}"); const v = eval(process.argv[1]); if (v != null) console.log(v)' "$1"; }

set_conf() {
  local k=$1 v=$2
  [[ $v =~ ^[A-Za-z0-9.:/_-]*$ ]] || die "refusing to write $k=$v"
  if grep -q "^$k=" "$CONFIG"; then sed -i "s|^$k=.*|$k=$v|" "$CONFIG"; else echo "$k=$v" >> "$CONFIG"; fi
}

node_running() { [[ -S $TS_SOCKET ]] && [[ $(ts status --json 2>/dev/null | jq_ 's.BackendState') == Running ]]; }
node_dns() { ts status --json | jq_ 's.Self && s.Self.DNSName && s.Self.DNSName.replace(/\.$/, "")'; }
# Is Funnel on for host:port in this serve config (stdin)?
funnel_on() { [[ $(jq_ "(s.AllowFunnel || {})['$1'] === true ? 1 : 0") == 1 ]]; }

# The gate on the node, port 443, with Funnel as asked (1/0). `tailscale serve`
# on a port turns Funnel off; `tailscale funnel` turns it on; `... off` would
# remove the handler altogether (the site would leave the tailnet too).
node_serve() {
  if [[ $1 == 1 ]]; then ts funnel --bg --https=443 "unix:$GATE_SOCKET"
  else ts serve --bg --https=443 "unix:$GATE_SOCKET"; fi
}

need_node() {
  [[ -n $SITE_HOSTNAME ]] || die "the site has no Tailscale node of its own; set one up: sudo webdata-admin site login <name>"
  node_running || die "the site's Tailscale node isn't running and logged in: sudo webdata-admin site login $SITE_HOSTNAME"
}

restart_gate() { systemctl restart webdata-gate.service; }

cmd=${1:-status}
[[ $# -gt 0 ]] && shift
case $cmd in
  login)
    name=${1:-$SITE_HOSTNAME}
    [[ -n $name ]] || die "give the name: sudo webdata-admin site login <name>   (the site becomes https://<name>.<tailnet>.ts.net/)"
    [[ $name =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "\"$name\" isn't a hostname: lowercase letters, digits and -"
    systemctl cat "$UNIT" >/dev/null 2>&1 || die "$UNIT isn't installed; update omb-webreports first: sudo webdata-admin update"
    id "$TS_USER" >/dev/null 2>&1 || die "user $TS_USER doesn't exist; update omb-webreports first: sudo webdata-admin update"
    set_conf SITE_HOSTNAME "$name"
    systemctl enable -q "$UNIT"
    systemctl start "$UNIT"
    for _ in $(seq 1 20); do [[ -S $TS_SOCKET ]] && break; sleep 0.5; done
    [[ -S $TS_SOCKET ]] || die "$UNIT didn't start: journalctl -u $UNIT -n 50"
    if node_running; then
      ts set --hostname="$name"
    else
      echo "Log the site's node in to your tailnet: open the link below and approve it."
      echo "(It's a new machine named $name; this waits until you do.)"
      ts up --hostname="$name" --accept-dns=false --accept-routes=false
    fi
    node_running || die "the node isn't logged in; try again: sudo webdata-admin site login $name"
    dns=$(node_dns)
    [[ -n $dns ]] || die "the node has no DNS name yet (MagicDNS and HTTPS certificates must be on for the tailnet)"
    # Keep Funnel as it was on the node (re-running serve alone would turn it off).
    funnel=0; ts serve status --json 2>/dev/null | funnel_on "$dns:443" && funnel=1
    node_serve "$funnel" >/dev/null
    set_conf SITE_URL "https://$dns"
    restart_gate
    echo
    echo "The site is at https://$dns/ (SITE_URL in $CONFIG), on your tailnet$( (( funnel )) && echo ' and the internet (Funnel is on)')."
    [[ $dns == "$name".* ]] || echo "note: Tailscale named it ${dns%%.*}, not $name (the name was taken): rename or remove the other machine, then run this again."
    if [[ -n $(ts status --json | jq_ 's.Self && s.Self.KeyExpiry') ]]; then
      echo "Turn off key expiry for it, or the site goes offline when the key expires:"
      echo "  https://login.tailscale.com/admin/machines → ${dns%%.*} → ⋯ → Disable key expiry"
    fi
    old=$(tailscale serve status --json 2>/dev/null | jq_ "Object.entries(s.Web || {}).filter(([, w]) => Object.values(w.Handlers || {}).some((h) => /^http:\/\/(127\.0\.0\.1|localhost):$GATE_PORT\/?$/.test(h.Proxy || ''))).map(([h]) => h).join(' ')" || true)
    for hp in $old; do
      echo "The old address https://${hp%:443} still serves the site (tailnet only). To retire it: sudo tailscale serve --https=${hp##*:} off"
    done
    (( funnel )) || echo "To open it to the internet (set passwords first: webdata-access status): sudo webdata-admin site funnel on"
    ;;

  funnel)
    want=${1:-}
    [[ $want == on || $want == off ]] || die "sudo webdata-admin site funnel on|off"
    on=0; [[ $want == on ]] && on=1
    if [[ -n $SITE_HOSTNAME ]]; then
      need_node
      node_serve "$on"
      where="https://$(node_dns)/"
    else
      # No node of its own: the machine's tailscale serve port for the gate (SITE_URL).
      [[ $SITE_URL =~ ^https://[^/]+\.ts\.net(:([0-9]+))?$ ]] || die "SITE_URL ($SITE_URL) isn't a tailscale serve address; set the site up first: sudo webdata-admin site login <name>"
      port=${BASH_REMATCH[2]:-443}
      if (( on )); then tailscale funnel --bg --https="$port" "http://127.0.0.1:$GATE_PORT"
      else tailscale serve --bg --https="$port" "http://127.0.0.1:$GATE_PORT"; fi
      where=$SITE_URL/
    fi
    if (( on )); then echo "Funnel is on: anyone on the internet can open $where (private databases still need their password)."
    else echo "Funnel is off: $where is on your tailnet only."; fi
    ;;

  logout)
    [[ -n $SITE_HOSTNAME ]] || die "the site has no Tailscale node of its own"
    if node_running; then
      dns=$(node_dns)
      ts serve --https=443 off >/dev/null 2>&1 || true
      ts logout || true
      echo "Logged out $dns. Remove the machine at https://login.tailscale.com/admin/machines if you won't use it again."
    fi
    systemctl disable -q --now "$UNIT" || true
    set_conf SITE_HOSTNAME ""
    # Back to the machine's own tailscale serve address for the gate, if there is one.
    url=$(tailscale serve status --json 2>/dev/null | jq_ "Object.entries(s.Web || {}).filter(([, w]) => Object.values(w.Handlers || {}).some((h) => /^http:\/\/(127\.0\.0\.1|localhost):$GATE_PORT\/?$/.test(h.Proxy || ''))).map(([h]) => 'https://' + h.replace(/:443$/, ''))[0]" || true)
    set_conf SITE_URL "${url:-http://127.0.0.1:$GATE_PORT}"
    restart_gate
    if [[ -n $url ]]; then echo "The site is at $url (SITE_URL in $CONFIG)."
    else echo "The site is at http://127.0.0.1:$GATE_PORT, this machine only: no tailscale serve points at the gate (SITE_URL in $CONFIG)."; fi
    ;;

  status)
    echo "site      $SITE_URL"
    if [[ -n $SITE_HOSTNAME ]]; then
      echo "node      $SITE_HOSTNAME: $UNIT $(systemctl is-active "$UNIT" 2>/dev/null || true)"
      if [[ -S $TS_SOCKET ]] && st=$(ts status --json 2>/dev/null); then
        state=$(jq_ 's.BackendState' <<<"$st")
        dns=$(jq_ 's.Self && s.Self.DNSName && s.Self.DNSName.replace(/\.$/, "")' <<<"$st")
        exp=$(jq_ 's.Self && s.Self.KeyExpiry' <<<"$st")
        if [[ $state != Running ]]; then exp=""
        elif [[ -n $exp ]]; then exp="; key expires ${exp:0:10}: disable key expiry for it in the admin console"
        else exp="; key expiry off"; fi
        echo "          $state${dns:+, $dns}$exp"
        if [[ -n $dns ]]; then
          sst=$(ts serve status --json 2>/dev/null || echo '{}')
          serving=$(jq_ "((s.Web || {})['$dns:443'] || {}).Handlers ? 1 : null" <<<"$sst")
          if [[ -n $serving ]]; then
            if funnel_on "$dns:443" <<<"$sst"; then echo "          https://$dns/ → webdata-gate: the INTERNET (Funnel is on)"
            else echo "          https://$dns/ → webdata-gate: your tailnet only (Funnel is off)"; fi
          else
            echo "          not serving the site: sudo webdata-admin site login $SITE_HOSTNAME"
          fi
        fi
      else
        echo "          not running or not logged in: sudo webdata-admin site login $SITE_HOSTNAME"
      fi
      deny=$(systemctl show -p IPAddressDeny --value "$UNIT" 2>/dev/null || true)
      if [[ $deny == *127.0.0.0/8* ]]; then echo "          loopback blocked (IPAddressDeny=$deny)"
      else echo "          WARNING: $UNIT may reach this machine's loopback (IPAddressDeny='$deny'): sudo webdata-admin update"; fi
    else
      echo "node      none (the site has no Tailscale node of its own: sudo webdata-admin site login <name>)"
    fi
    echo "machine   tailscale serve on this machine:"
    tailscale serve status 2>/dev/null | sed -e '/^[[:space:]]*$/d' -e 's/^/          /' || echo "          (couldn't ask tailscale)"
    ;;

  *) die "unknown: site $cmd (status, login [<name>], funnel on|off, logout)" ;;
esac
