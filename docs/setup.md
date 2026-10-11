# Setup

From a fresh machine to a working reports site with bots that can build
reports. Tested on **Ubuntu 26.04 LTS** with OpenMausBot 0.1.104; other
Debian-family releases with systemd should work the same.

Everything runs as one normal user (below: `you`) who has `sudo`. That user
runs OpenMausBot and owns the omb-webreports checkout.

1. [Base packages](#1-base-packages)
2. [Tailscale](#2-tailscale)
3. [OpenMausBot and its native modules](#3-openmausbot-and-its-native-modules) ← the DuckDB part
4. [Run OpenMausBot as a service](#4-run-openmausbot-as-a-service)
5. [Chrome for the bots' browser](#5-chrome-for-the-bots-browser)
6. [Configure omb-webreports](#6-configure-omb-webreports)
7. [Install](#7-install)
8. [HTTPS for phones](#8-https-for-phones)
9. [Teach your bots the skills](#9-teach-your-bots-the-skills)
10. [Optional: job failure notifications](#10-optional-job-failure-notifications)
11. [Verify everything](#11-verify-everything)

## 1. Base packages

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates python3 acl
```

## 2. Tailscale

The site is only reachable from your tailnet, and Tailscale also provides the
HTTPS certificate. Install it from Tailscale's repository (the commands for
your release are at https://tailscale.com/download/linux), for example:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4          # this machine's tailnet address, e.g. 100.x.y.z
```

In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**
(needed for step 8).

## 3. OpenMausBot and its native modules

OpenMausBot needs Node.js; install Node 24 from NodeSource
(https://github.com/nodesource/distributions):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version           # v24.x
```

### Why there's an extra step for DuckDB

OpenMausBot's data features (tables, SQL, sheet cards, charts) run on DuckDB
through the native module `@duckdb/node-api`, and chart images are rendered
with the native module `@resvg/resvg-js`. **The `openmausbot` npm package
does not ship these native modules.** Installed with plain
`npm install -g openmausbot`, the service starts, but every data tool fails with
an `engine_unavailable` error like:

> DuckDB did not load from the server's node_modules: Cannot find module '@duckdb/node-api' … Run pnpm install, or set OMB_DUCKDB_DIR to a folder holding node_modules/@duckdb.

and charts don't render. The fix has two parts:

1. Install the **exact versions this OpenMausBot release pins** (each release
   lists them in the `package.json` of its `vX.Y.Z` tag on GitHub) as global
   modules, so they land in `/usr/lib/node_modules`. A mismatched DuckDB
   version can fail to load, or upgrade the database file format under you.
2. Tell the service where they are with a systemd drop-in:
   `Environment=OMB_DUCKDB_DIR=/usr/lib` (OpenMausBot looks in
   `$OMB_DUCKDB_DIR/node_modules`).

omb-webreports reuses the same two modules (to snapshot databases, run SQL,
apply data jobs and render icons), so this must be in place before installing it.

### The browser's DuckDB has to match

Reports run DuckDB in the browser (DuckDB-WASM), and it must contain the
**same DuckDB engine** as OpenMausBot's `@duckdb/node-api`: same SQL, same
results, and it reads the same files the bots write. DuckDB-WASM has its own
version numbers and release schedule (DuckDB-WASM 1.33.1-dev65.0 contains
DuckDB v1.5.6), and it can lag a new DuckDB by weeks. So upgrading OpenMausBot
first checks that a matching DuckDB-WASM build exists, and pins the browser to it
(`DUCKDB_WASM_VERSION` in `config.env`).

### Install

[`admin/openmausbot-upgrade.sh`](../admin/openmausbot-upgrade.sh) in the
omb-webreports checkout does all of it, so get the checkout first:

```bash
git clone https://github.com/ckedwards/omb-webreports.git ~/omb-webreports
cd ~/omb-webreports
admin/openmausbot-upgrade.sh            # latest release; or: admin/openmausbot-upgrade.sh 0.1.107
```

It:
1. reads the native module versions the release pins (from its GitHub tag);
2. finds the DuckDB-WASM build with the same DuckDB engine, **before changing
   anything**. If there isn't one, it names the newest OpenMausBot release that
   has one and asks whether to continue anyway; when it can't ask (no
   terminal, e.g. in a script or cron) it stops. `--skip-browser-check`
   continues regardless;
3. installs or upgrades `openmausbot` and the native modules globally (with
   `sudo`), and creates the systemd drop-in if it's missing;
4. writes `DUCKDB_WASM_VERSION` into `config.env` (creating it from
   `config.example.env` if needed), restarts `webdata-sync`/`webdata-jobs` if
   they're installed, then restarts OpenMausBot.

On a first install it stops after step 4 with a note that the OpenMausBot service
doesn't exist yet; that's the next step. `admin/openmausbot-upgrade.sh --check`
shows the installed versions, whether browser and server match, and the newest
release with a match, without changing anything.

<details>
<summary>The same thing by hand (OpenMausBot 0.1.104)</summary>

```bash
sudo npm install -g openmausbot@0.1.104
sudo npm install -g @duckdb/node-api@1.5.6-r.1 @resvg/resvg-js@2.6.2
sudo mkdir -p /etc/systemd/system/openmausbot.service.d
printf '[Service]\nEnvironment=OMB_DUCKDB_DIR=/usr/lib\n' | \
  sudo tee /etc/systemd/system/openmausbot.service.d/duckdb.conf
```

For other releases, take the versions from
`https://raw.githubusercontent.com/milind-soni/OpenMausBot/v<version>/package.json`.
</details>

The by-hand route skips the browser check; afterwards run
`admin/openmausbot-upgrade.sh --check`, and set `DUCKDB_WASM_VERSION` to the
build it reports.

**Always upgrade OpenMausBot with the script** (`admin/openmausbot-upgrade.sh`):
a new release may pin new native module versions, which `npm install -g
openmausbot` alone won't install, and the browser's DuckDB has to follow.

## 4. Run OpenMausBot as a service

As `you` (not root):

```bash
openmausbot setup                          # first-run setup: AI access, keeps existing bots
openmausbot service install --tailscale    # writes ~/.openmausbot/openmausbot.service
```

`service install` prints the commands to install the unit; they are:

```bash
sudo install -m 644 ~/.openmausbot/openmausbot.service /etc/systemd/system/openmausbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now openmausbot
```

Then run the upgrade script once more so it sees the service, checks the
drop-in and restarts with the native modules:

```bash
admin/openmausbot-upgrade.sh
systemctl show openmausbot -p Environment     # must include OMB_DUCKDB_DIR=/usr/lib
```

Pair your phone or browser with OpenMausBot as its docs describe, create a bot,
and confirm its data tools work: ask it to create a small table. If you see
`engine_unavailable`, go back to step 3.

## 5. Chrome for the bots' browser

Bots browse with agent-browser and Chrome for Testing; omb-webreports uses the
same browser to check reports (`webdata-check`) and to scrape pages that need
JavaScript (`webdata-browse`). Chrome needs some system libraries first:

```bash
sudo openmausbot browser install --with-deps   # once, as root: the libraries
openmausbot browser install                    # as you: agent-browser + Chrome
```

## 6. Configure omb-webreports

The checkout from step 3 can live anywhere you own (move it now if you want it
elsewhere). The upgrade script created `config.env`; if it's missing, `cp
config.example.env config.env`. Edit it; the defaults work for a typical setup:

| Setting | Default | Set it when |
|---|---|---|
| `WEBREPORTS_OWNER` | the user who runs `sudo` | you install from another account |
| `LISTEN_IP` | `tailscale ip -4` | you don't use Tailscale, or want another address |
| `LISTEN_PORT` | `8080` | the port is taken |
| `ALLOWED_NETS` | Tailscale's ranges | clients come from elsewhere (e.g. `127.0.0.1`) |
| `SITE_URL` | `http://LISTEN_IP:LISTEN_PORT` | **set it** to your HTTPS URL from step 8, e.g. `https://mybox.tail1234.ts.net:8443`: tools and bots use it in links |
| `OMB_DATA_DIR` | `~/.openmausbot` | OpenMausBot runs with another `--data-dir` |
| `NODE_MODULES_DIR` | `/usr/lib/node_modules` | your global modules live elsewhere |
| `DUCKDB_WASM_VERSION` | set by `admin/openmausbot-upgrade.sh` | never by hand: it's the browser build matching OpenMausBot's DuckDB |

## 7. Install

```bash
sudo bash admin/install.sh --print   # optional: show every file it will write
sudo bash admin/install.sh
```

The installer:

- checks the prerequisites (Node 20+, the two native modules, OpenMausBot's data
  dir), and warns if the browser's DuckDB doesn't match OpenMausBot's;
- installs Apache and **dedicates it to this site**: it replaces
  `/etc/apache2/ports.conf` to listen only on `LISTEN_IP:LISTEN_PORT`,
  disables the default site, and installs a hardened virtual host serving
  `webroot/` (see [architecture](architecture.md#security-model)). Don't run it
  on a machine whose Apache serves other sites;
- gives Apache's user read-only access to `webroot/` and traverse-only access
  to the folders above it (POSIX ACLs; it can't list or read anything else);
- installs and starts two services running as you, sandboxed:
  `webdata-sync` (publishes bot databases) and `webdata-jobs` (scheduled jobs);
- links the `webdata-*` tools into `/usr/local/bin`.

It's idempotent: re-run it after `git pull` or after editing `config.env`.

## 8. HTTPS for phones

Plain HTTP works on the tailnet, but iPhones treat it as insecure. Put
Tailscale's HTTPS in front (the port is your choice; 8443 keeps 443 free for
OpenMausBot's own `--tailscale` endpoint):

```bash
tailscale serve --bg --https=8443 http://$(tailscale ip -4):8080
tailscale serve status
```

Set `SITE_URL` in `config.env` to the URL it prints (e.g.
`https://mybox.tail1234.ts.net:8443`); the tools read it on each run, no
reinstall needed.

## 9. Teach your bots the skills

Bots learn skills through OpenMausBot's own skill store, and only take a
`SKILL.md` file. In a chat with each bot that should build reports:

```
/learn Create one skill per file with skill_manage, using each file's contents
exactly as written: ~/omb-webreports/skills/webdata-reports-read/SKILL.md,
~/omb-webreports/skills/webdata-report-create/SKILL.md,
~/omb-webreports/skills/webdata-report-update/SKILL.md and
~/omb-webreports/skills/webdata-data-job/SKILL.md. Use the file path as the source.
```

(Adjust the paths to your checkout.) You confirm each skill in the app. When a
skill file changes after a `git pull`, ask the bot to update its learned skill
of the same name: the bot keeps its approved copy, not a link.

Bots will ask for approval to read and write the checkout and to run the
`webdata-*` commands; allow them in the bot's settings if that gets tedious.

## 10. Optional: job failure notifications

To have a bot fix a scheduled data job when it fails, create an OpenMausBot
webhook for that bot and register its URL. See
[data-jobs.md](data-jobs.md#failure-notifications).

## 11. Verify everything

```bash
webdata-info                    # versions, paths, all four services "active", browser DuckDB "same as the server"
webdata-check _gallery          # renders the design gallery on a headless iPhone: must print OK
```

Then open `SITE_URL/` on your phone: the front page lists your reports and
the published databases. Open `SITE_URL/reports/_gallery/` to see every
component. To install a report as an app: Safari → Share → Add to Home Screen.

Next: ask a bot to make its first report. Day-to-day use, logs and
troubleshooting are in [operations.md](operations.md).
