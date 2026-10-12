# Operations

## Everyday commands

```bash
webdata-info                       # locations (SITE, REPORTS, JOBS, DATA, DOCS), versions, services, what's installed
webdata-ls                         # reports + databases (main tables)
webdata-ls data                    # every table with columns and types
webdata-ls <slug>                  # one report: link, files, tables it uses
webdata-sql "SELECT … FROM <bot>.main.<table>"
webdata-check <slug>               # render on a headless iPhone, light + dark; exit 1 on problems
webdata-errors --since 1h          # JavaScript errors reported by real browsers and phones
webdata-new-report <slug> "<Title>" <bot> "<description>"
webdata-sync --once                # one sync pass now; prints warnings (bad report.json, …)
webdata-bake <slug>                # re-bake a report's first render now (the service does this itself)
webdata-job list                   # scheduled jobs: last result, next run (see data-jobs.md)
```

Everything that needs root is one command, `sudo webdata-admin` (bots can't
use sudo, so they can't run it):

```bash
sudo webdata-admin status          # install + available update, versions, services, isolation, bots' skills, failure alerts
sudo webdata-admin update          # update omb-webreports (below)
sudo webdata-admin pair            # a pairing code for a new browser or device (full access; --chat-only)
sudo webdata-admin skills status   # bots with the omb-webreports skills: current or outdated
sudo webdata-admin upgrade-openmausbot --check
```

## Services and logs

| Service | Logs |
|---|---|
| `webdata-sync` | `journalctl -u webdata-sync -f` (bakes log as `bake: …`) |
| `webdata-jobs` | `journalctl -u webdata-jobs -f`; per run: `webdata-job logs <name>` |
| `webdata-notify` | `journalctl -u webdata-notify -f`; state: `webdata-notify status` |
| `apache2` | `/var/log/apache2/webdata-access.log`, `webdata-error.log` |
| `openmausbot` | `journalctl -u openmausbot -f` |

Reading Apache's logs (and `webdata-errors`) needs membership in the `adm`
group. Every page loads `lib/report-errors.js` first, which reports JavaScript
errors as `GET /_client-error?…` requests; the server answers 404 and the access
log keeps them for `webdata-errors`.

## Where things are

| | Where | Owner |
|---|---|---|
| Settings | `/etc/omb-webreports/config.env` | root |
| What's installed (source, commit) | `/etc/omb-webreports/installed.json` | root |
| The program (tools, skills, docs, shared site files) | `/usr/local/lib/omb-webreports` | root |
| The source clone (installs and updates run from it) | `/usr/local/src/omb-webreports` | root |
| Reports, published data, jobs, state | `/var/lib/omb-webreports` (`DATA_DIR`) | you |

## Settings

- `/etc/omb-webreports/config.env`: owner, content folder, listen address,
  allowed networks, site URL, paths, OpenMausBot isolation. Edit it as root,
  then re-run `sudo /usr/local/src/omb-webreports/admin/install.sh`. The tools read it on
  each run.
- `DATA_DIR/sync.json` (optional, yours to edit):
  `{ "exclude_bots": ["SomeBot"], "poll_seconds": 3, "bake": true, "bake_max_kb": 1024 }`.
  Excluded bots are never published; delete an already-published
  `DATA_DIR/data/<bot>.duckdb` by hand. `"bake": false` turns off baked first
  renders (reports then start DuckDB-WASM on every first visit);
  `bake_max_kb` skips reports whose first render returns more than that.

## Troubleshooting

**A report is broken on a phone but fine on desktop.** Run
`webdata-errors --since 1h`. `Importing binding name '…' is not found` means the
phone ran a stale `kit.js`: check the page still has its
`<!-- webdata:modules -->` block (`webdata-sync --once` warns about pages that
don't), and that `webdata-sync` is running. Shared files are cached by their
`?v=` URL for a year, so a page whose `/lib/` URLs lost their `?v=` (or a
hand-written stale one) is the other thing to check: `webdata-sync --once`
re-stamps them.

**A report shows old data.** `webdata-ls` shows when each database was last
published. If the bot's data changed but the snapshot didn't:
`systemctl status webdata-sync` and its journal. Open pages pick up new data
within ~20 s; a page in the background checks when it's shown again.

**A report is slow on first visit** (the status shows "Loading…" for a second
or more). Its first render isn't baked. `journalctl -u webdata-sync | grep bake:`
says why: the render failed (fix the report; it retries after 10 minutes or
on the next change), it was too large (`bake_max_kb`), or it ran no cacheable
queries. `webdata-check <slug>` bakes and reports `rendered: … (from baked
first render)` when it works. A first render that depends on the viewer (a
remembered tab, the screen width) can't use the bake for those viewers.

**"Something went wrong" banner.** The message is the SQL or JavaScript error;
`webdata-check <slug>` shows the same plus page and console errors. Common
causes: a table or column was renamed in the bot's database; the report names a
database not listed in its `report.json`.

**The site doesn't load.** `webdata-info` (services), then
`curl -I http://<LISTEN_IP>:<LISTEN_PORT>/`. Apache binds to `LISTEN_IP`; if
that's the Tailscale address and Tailscale isn't up, Apache retries every 5 s
until it is. For the HTTPS URL: `tailscale serve status`.

**403 Forbidden.** The client isn't in `ALLOWED_NETS`, the request isn't
GET/HEAD, or the path contains a dotfile. A 403 on all reports means Apache
lost read access to `DATA_DIR` (its ACLs): re-run
`sudo /usr/local/src/omb-webreports/admin/install.sh`.

**`engine_unavailable` / DuckDB did not load** (in OpenMausBot, or the
tools fail to import `@duckdb/node-api`). The native modules are missing or
don't match the OpenMausBot release: `sudo webdata-admin upgrade-openmausbot`
(see [setup step 3](setup.md#3-openmausbot-and-its-native-modules)).

**A query works in `webdata-sql` but fails in the browser (or the other way
round), or reports show a DuckDB error after an upgrade.** The browser's DuckDB
may not match OpenMausBot's. `webdata-info` shows both ("browser DuckDB");
`sudo webdata-admin upgrade-openmausbot --check` checks them properly. To realign, re-run
`sudo webdata-admin upgrade-openmausbot <installed openmausbot version>`: it re-pins
`DUCKDB_WASM_VERSION` and restarts sync, which re-stamps every page. If no
matching browser build exists yet (an upgrade made with `--skip-browser-check`),
either go back to the release the check names, or wait for a DuckDB-WASM build
and re-run. Snapshots use storage format v1.2.0, which every DuckDB since 1.2
reads, so a lagging browser can still open them.

**`openmausbot pair` refuses ("does not treat commands on this computer as its
owner").** Expected with isolation. Pair from a device that's already signed
in (Settings → Remote access), or run `sudo webdata-admin pair`: it prints a
code and the link to OpenMausBot's `/pair` page. The new device gets full
access; `--chat-only` gives one that can chat, read threads, answer approval
cards and manage routines, but can't change bots, settings, keys, devices or
webhooks. Answering approval cards still lets it OK what a bot does, so give
it only to someone you'd trust with that. `--label NAME` names the device.

**`webdata-skills` says the session expired, or there is none.** The daily
timer keeps it alive; if OpenMausBot was down for weeks or the session was
revoked in the app, create a full-access pairing code in the app (Settings →
Remote access) and run `sudo webdata-admin skills login --code <code>`.
(`webdata-admin pair` can't help here: it makes codes with that same session.)

**A data job fails.** `webdata-job logs <name>`; see
[data-jobs.md](data-jobs.md#when-a-job-fails).

## Upgrades

**omb-webreports:**

```bash
sudo webdata-admin update               # fast-forward the clone's branch, then install
sudo webdata-admin update --ref v1.2.0  # or a tag, branch or commit
```

(`webdata-admin update` runs `admin/update.sh` in the root-owned clone the
install came from, `/usr/local/src/omb-webreports`; running that script
directly does the same.)

It refuses if the clone isn't root-owned or has local changes, then runs the
new installer, which copies the program to `/usr/local/lib/omb-webreports`
and restarts the services. (Developing omb-webreports itself:
[development.md](development.md).) The installer ends with `webdata-skills sync`: bots that have the
omb-webreports skills get the new versions (each stays on or off as it was), and
the Report builder preset is replaced by the new release. To see what changed
first: `git -C /usr/local/src/omb-webreports log -p -- skills/`; to preview: `webdata-skills sync --dry-run`.

**Bots' skills, by hand:**

```bash
sudo webdata-admin skills status          # each bot: which skills, current or outdated, on/off
sudo webdata-admin skills add <bot>       # give a bot the four skills (switched on)
sudo webdata-admin skills sync [--dry-run]  # update outdated copies + the preset
```

They use OpenMausBot's API on this machine (`OMB_URL`, default
`http://127.0.0.1:8799`) with webdata-skills' own session (see below). Without
isolation (`OMB_LOOPBACK_TRUST=owner`) no session or `sudo` is needed.

**OpenMausBot isolation** (`OMB_LOOPBACK_TRUST=service`, see
[architecture](architecture.md#security-model)): `webdata-info` shows whether
it's on and whether webdata-skills has its session.

```bash
sudo webdata-admin skills login               # new session (needs a pairing code once isolated)
sudo webdata-admin skills login --code <code> # the same, non-interactively
sudo webdata-admin skills logout              # revoke it
systemctl list-timers webdata-omb-session.timer   # the daily renewal; journalctl -u webdata-omb-session
```

To turn isolation off: `OMB_LOOPBACK_TRUST=owner` (or empty) in
`/etc/omb-webreports/config.env`, then `sudo /usr/local/src/omb-webreports/admin/install.sh`.

**OpenMausBot:** always through the script, so its native modules and the
browser's DuckDB match:

```bash
sudo webdata-admin upgrade-openmausbot --check     # versions, match, newest release with a match
sudo webdata-admin upgrade-openmausbot             # latest
sudo webdata-admin upgrade-openmausbot 0.1.107     # or a specific version (also rolls back)
```

Before changing anything it looks for the DuckDB-WASM build with the target's
DuckDB engine. If there's none, it names the newest release that has one and
asks whether to continue; without a terminal it stops (exit 1). Add
`--skip-browser-check` to upgrade regardless, accepting that reports run a
different DuckDB until a matching build appears.

## Uninstall

```bash
sudo webdata-admin skills logout                  # revoke its OpenMausBot session
sudo systemctl disable --now webdata-sync webdata-jobs webdata-notify webdata-omb-session.timer
sudo rm /etc/systemd/system/webdata-{sync,jobs,notify}.service /etc/systemd/system/webdata-omb-session.{service,timer}
sudo rm -r /var/lib/omb-webreports-notify          # then delete the "omb-webreports job failures" webhooks in OpenMausBot
sudo rm -r /etc/omb-webreports /etc/systemd/system/openmausbot.service.d/omb-webreports-loopback.conf
sudo systemctl restart openmausbot                # back to OpenMausBot's default local trust
sudo rm /etc/systemd/system/apache2.service.d/tailscale.conf
sudo a2dissite webdata && sudo a2disconf zz-reports-hardening
sudo rm /etc/apache2/sites-available/webdata.conf /etc/apache2/conf-available/zz-reports-hardening.conf
sudo rm /usr/local/bin/webdata-*
sudo rm -r /usr/local/lib/omb-webreports /usr/local/src/omb-webreports /var/cache/omb-webreports
sudo systemctl daemon-reload
tailscale serve --https=8443 off
```

Apache stays installed; restore `/etc/apache2/ports.conf` (`Listen 80`) and
re-enable `000-default` if you use it for something else. Your content in
`/var/lib/omb-webreports` and OpenMausBot's data are untouched; delete the
content folder yourself if you don't want it.
