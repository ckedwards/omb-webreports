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
webdata-job list                   # scheduled jobs: last result, next run (see data-jobs.md)
```

## Services and logs

| Service | Logs |
|---|---|
| `webdata-sync` | `journalctl -u webdata-sync -f` |
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
  `{ "exclude_bots": ["SomeBot"], "poll_seconds": 3 }`. Excluded bots are never
  published; delete an already-published `webroot/data/<bot>.duckdb` by hand.

## Troubleshooting

**A report is broken on a phone but fine on desktop.** Run
`webdata-errors --since 1h`. `Importing binding name '…' is not found` means the
phone ran a stale `kit.js`: check the page still has its
`<!-- webdata:modules -->` block (`webdata-sync --once` warns about pages that
don't), and that `webdata-sync` is running.

**A report shows old data.** `webdata-ls` shows when each database was last
published. If the bot's data changed but the snapshot didn't:
`systemctl status webdata-sync` and its journal. Open pages pick up new data
within ~20 s; a page in the background checks when it's shown again.

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
don't match the OpenMausBot release: `bash scripts/openmausbot-upgrade.sh`
(see [setup step 3](setup.md#3-openmausbot-and-its-native-modules)).

**Reports fail after an OpenMausBot upgrade with a DuckDB error in the
browser.** Snapshots are written with a pinned storage version that the
browser's DuckDB-WASM (1.4.x) reads; a much newer `@duckdb/node-api` could
eventually drop writing that version. Check `webdata-sync` logs for snapshot
errors, and see `SNAPSHOT_FORMAT` in `bin/webdata-sync` and `DUCKDB_WASM` in
`webroot/lib/kit.js`.

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

**OpenMausBot:** always through the script, so its native modules match:

```bash
bash scripts/openmausbot-upgrade.sh            # latest
bash scripts/openmausbot-upgrade.sh 0.1.105    # or a specific version (also rolls back)
```

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
