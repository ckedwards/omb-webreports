# Development

Production installs come from a root-owned clone, because root runs the
installer and the code it installs ([setup](setup.md)). Development needs a
checkout you can edit, so it's kept apart and installed only on purpose.

## The layout

| | Where | Owner |
|---|---|---|
| Your development checkout | e.g. `~/repos/omb-webreports` | you |
| The production clone (optional on a dev machine) | `/usr/local/src/omb-webreports` | root |
| The installed program | `/usr/local/lib/omb-webreports` | root |
| Settings, install record, webdata-skills' session | `/etc/omb-webreports/` | root |
| Content: reports, published data, jobs | `/var/lib/omb-webreports` (`DATA_DIR`) | you |

## Working in the checkout

The tools find their code next to themselves and everything else from
`/etc/omb-webreports/config.env`, so you can run them **straight from the
checkout**, as yourself, against the live content:

```bash
cd ~/repos/omb-webreports
bin/webdata-sync --once            # your sync code, against the live data
bin/webdata-check blue-jays-2026   # your checker; the page is served by the installed site (Apache, 127.0.0.1)
bin/webdata-skills package         # regenerate skills/omb-webreports.openmaus.json after editing skills/
```

What the site *serves* (the front page, `/lib/`, the gallery) and what the
services *run* is the installed copy. To try a change there, install the
checkout:

```bash
sudo ~/repos/omb-webreports/admin/update.sh --from-unsafe-dev
```

That skips git (the checkout is installed as it is), warns, logs the install
as unsafe in the system journal (`journalctl -t omb-webreports`), and records it
in `/etc/omb-webreports/installed.json`; `webdata-info` shows "installed from
… UNSAFE" until the next normal install. It's unsafe because anything that can
write the checkout, including bots running as you, decides what root runs.
`admin/install.sh` and `admin/openmausbot-upgrade.sh` take `--from-unsafe-dev`
too; without it they refuse a source that isn't root-only.

## Testing the installer without root

```bash
bash admin/install.sh --destdir /tmp/omb-test --from-unsafe-dev --yes   # WEBREPORTS_OWNER=you in the environment
bash admin/install.sh --print --destdir /tmp/omb-test --from-unsafe-dev
```

`--destdir` writes the whole system layout (program, settings, content folder,
Apache and systemd files, tool links) under that folder and skips everything
that needs root (packages, ownership, ACLs, services). Point the tools at it
with `OMB_WEBREPORTS_CONFIG=/tmp/omb-test/etc/omb-webreports/config.env` plus
`DATA_DIR`/`PLATFORM_DIR` overrides. Test against a throwaway OpenMausBot
(`openmausbot serve --port 18799 --data-dir /tmp/omb-test-omb`, then
`OMB_URL=http://127.0.0.1:18799`), never your real bots.

## Testing the gate and the alerts

Both are root-side services, so test them against throwaway copies, never the
live ones:

- **webdata-gate:** generate the Apache config with a `--destdir` install
  (`LISTEN_PORT=18080 GATE_PORT=18081 DATA_DIR=/tmp/omb-test-data`), start a
  throwaway Apache from it as yourself (`/usr/sbin/apache2 -f <conf> -k start`,
  with a `PidFile`, `ErrorLog` and the modules the vhost needs), copy a few
  reports and databases into the test `DATA_DIR`, and run
  `OMB_WEBREPORTS_CONFIG=<the test config.env> WEBDATA_GATE_KEY=/tmp/gatekey bin/webdata-gate`.
  `bin/webdata-access` with the same `OMB_WEBREPORTS_CONFIG` sets passwords
  there. Test path tricks with `curl --path-as-is`: plain curl removes `./` and
  `%2e%2e` itself, so the gate never sees them. The gate also listens on
  `WEBDATA_GATE_SOCKET` when that file's directory exists (`curl --unix-socket`).
- **The site's own node:** `webdata-admin site status` and `webdata-access
  status` read a scratch `tailscaled --tun=userspace-networking --statedir=<dir>
  --socket=<dir>/ts.sock --port=0` (as yourself, never logged in) through
  `WEBDATA_SITE_TS_SOCKET=<dir>/ts.sock`; run `bin/_admin-site.sh` with a stub
  `runuser` on `PATH` (it drops `-u <user> --`). The loopback block
  (`IPAddressDeny`) only holds in the system unit: a user unit ignores it. Check
  it on the real node from another tailnet machine (or this one, through
  Tailscale): `curl http://<node's 100.x address>:8080/` must fail.
- **webdata-notify:** a throwaway OpenMausBot (above) with a bot or two, scratch
  jobs, and `WEBDATA_JOBS_DIR`, `WEBDATA_JOBS_STATE`, `WEBDATA_NOTIFY_DIR`,
  `OMB_URL` and `WEBDATA_OMB_SESSION` (a file that doesn't exist) pointing at
  them; `bin/webdata-notify once` runs one pass. The alert rules
  (`decide()` in `bin/_notify.mjs`) can be tested on their own.

Stop throwaway servers by their own process group (`ss -ltnp` names the
listening process), never with a `pkill -f` pattern.

## Releasing

Commit and push; production machines then run `sudo webdata-admin update` (or
`--ref <tag>`). After editing `skills/`, run `bin/webdata-skills package` and
commit the regenerated package with the skills.
