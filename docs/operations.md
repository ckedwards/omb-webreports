# Operations

## Everyday commands

```bash
webdata-info                       # paths, site URL, versions, service status
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

## Services and logs

| Service | Logs |
|---|---|
| `webdata-sync` | `journalctl -u webdata-sync -f` (bakes log as `bake: …`) |
| `webdata-jobs` | `journalctl -u webdata-jobs -f`; per run: `webdata-job logs <name>` |
| `apache2` | `/var/log/apache2/webdata-access.log`, `webdata-error.log` |
| `openmausbot` | `journalctl -u openmausbot -f` |

Reading Apache's logs (and `webdata-errors`) needs membership in the `adm`
group. Every page loads `lib/report-errors.js` first, which reports JavaScript
errors as `GET /_client-error?…` requests; the server answers 404 and the access
log keeps them for `webdata-errors`.

## Settings

- `config.env`: owner, listen address, allowed networks, site URL, paths.
  After changing the listen address, port or networks, re-run
  `sudo bash admin/install.sh`. `SITE_URL` and paths are read by the tools on each run.
- `sync.json` (optional, git-ignored):
  `{ "exclude_bots": ["SomeBot"], "poll_seconds": 3, "bake": true, "bake_max_kb": 1024 }`.
  Excluded bots are never published; delete an already-published
  `webroot/data/<bot>.duckdb` by hand. `"bake": false` turns off baked first
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
GET/HEAD, or the path contains a dotfile. A 403 on everything right after
moving the checkout means Apache lost access to the folders above it: re-run
`sudo bash admin/install.sh`.

**`engine_unavailable` / DuckDB did not load** (in OpenMausBot, or the
tools fail to import `@duckdb/node-api`). The native modules are missing or
don't match the OpenMausBot release: `admin/openmausbot-upgrade.sh`
(see [setup step 3](setup.md#3-openmausbot-and-its-native-modules)).

**A query works in `webdata-sql` but fails in the browser (or the other way
round), or reports show a DuckDB error after an upgrade.** The browser's DuckDB
may not match OpenMausBot's. `webdata-info` shows both ("browser DuckDB");
`admin/openmausbot-upgrade.sh --check` checks them properly. To realign, re-run
`admin/openmausbot-upgrade.sh <installed openmausbot version>`: it re-pins
`DUCKDB_WASM_VERSION` and restarts sync, which re-stamps every page. If no
matching browser build exists yet (an upgrade made with `--skip-browser-check`),
either go back to the release the check names, or wait for a DuckDB-WASM build
and re-run. Snapshots use storage format v1.2.0, which every DuckDB since 1.2
reads, so a lagging browser can still open them.

**A data job fails.** `webdata-job logs <name>`; see
[data-jobs.md](data-jobs.md#when-a-job-fails).

## Upgrades

**omb-webreports:**

```bash
cd ~/omb-webreports
git pull
sudo bash admin/install.sh      # applies changes to Apache/services; safe to repeat
```

If the skills changed (`git log -- skills/`), ask your bots to update their
learned skills from the files.

**OpenMausBot:** always through the script, so its native modules and the
browser's DuckDB match:

```bash
admin/openmausbot-upgrade.sh --check            # versions, match, newest release with a match
admin/openmausbot-upgrade.sh                    # latest
admin/openmausbot-upgrade.sh 0.1.107            # or a specific version (also rolls back)
```

Before changing anything it looks for the DuckDB-WASM build with the target's
DuckDB engine. If there's none, it names the newest release that has one and
asks whether to continue; without a terminal it stops (exit 1). Add
`--skip-browser-check` to upgrade regardless, accepting that reports run a
different DuckDB until a matching build appears.

## Uninstall

```bash
sudo systemctl disable --now webdata-sync webdata-jobs
sudo rm /etc/systemd/system/webdata-{sync,jobs}.service
sudo rm /etc/systemd/system/apache2.service.d/tailscale.conf
sudo a2dissite webdata && sudo a2disconf zz-reports-hardening
sudo rm /etc/apache2/sites-available/webdata.conf /etc/apache2/conf-available/zz-reports-hardening.conf
sudo rm /usr/local/bin/webdata-*
sudo systemctl daemon-reload
tailscale serve --https=8443 off
```

Apache stays installed; restore `/etc/apache2/ports.conf` (`Listen 80`) and
re-enable `000-default` if you use it for something else. The checkout, your
reports and OpenMausBot's data are untouched; delete the checkout yourself.
