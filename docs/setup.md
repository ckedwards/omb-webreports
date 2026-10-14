# Setup

From a fresh machine to a working reports site with bots that can build
reports. Tested on **Ubuntu 26.04 LTS** with OpenMausBot 0.1.107; other
Debian-family releases with systemd should work the same.

Everything runs as one normal user (below: `you`) who has `sudo`. That user
runs OpenMausBot and owns the content folder (`/var/lib/omb-webreports`: reports,
published data, jobs); the program itself is root's.

1. [Base packages](#1-base-packages)
2. [Tailscale](#2-tailscale)
3. [OpenMausBot and its native modules](#3-openmausbot-and-its-native-modules) ← the DuckDB part
4. [Run OpenMausBot as a service](#4-run-openmausbot-as-a-service)
5. [Chrome for the bots' browser](#5-chrome-for-the-bots-browser)
6. [HTTPS for phones](#6-https-for-phones)
7. [Install](#7-install)
8. [Settings and updates](#8-settings-and-updates)
9. [Teach your bots the skills](#9-teach-your-bots-the-skills)
10. [Job failure notifications](#10-job-failure-notifications)
11. [Verify everything](#11-verify-everything)
12. [Optional: pages on the internet](#12-optional-pages-on-the-internet)

## 1. Base packages

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates python3 acl
```

## 2. Tailscale

The site is reachable from your tailnet only (pages you choose can also go on
the internet through Cloudflare: step 12), and Tailscale also provides the HTTPS
certificate. Install it from Tailscale's repository (the commands for
your release are at https://tailscale.com/download/linux), for example:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4          # this machine's tailnet address, e.g. 100.x.y.z
```

In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**
(needed for step 6).

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
(`DUCKDB_WASM_VERSION` in `/etc/omb-webreports/config.env`).

### Install

omb-webreports is installed from a **root-owned clone**: its installer, update
and OpenMausBot-upgrade scripts run as root, so nothing your user (or a bot
running as you) can write may end up in them. Clone it as root, then run
[`admin/openmausbot-upgrade.sh`](../admin/openmausbot-upgrade.sh) from it:

```bash
sudo git clone https://github.com/ckedwards/omb-webreports.git /usr/local/src/omb-webreports
sudo /usr/local/src/omb-webreports/admin/openmausbot-upgrade.sh     # latest; or add a version: 0.1.107
```

It:
1. reads the native module versions the release pins (from its GitHub tag);
2. finds the DuckDB-WASM build with the same DuckDB engine, **before changing
   anything**. If there isn't one, it names the newest OpenMausBot release that
   has one and asks whether to continue anyway; when it can't ask (no
   terminal, e.g. in a script or cron) it stops. `--skip-browser-check`
   continues regardless;
3. installs or upgrades `openmausbot` and the native modules globally, and
   creates the systemd drop-in if it's missing;
4. once omb-webreports is installed, writes `DUCKDB_WASM_VERSION` into
   `/etc/omb-webreports/config.env` and restarts `webdata-sync`/`webdata-jobs`
   (on this first run there's nothing to update yet; the installer picks the
   build in step 7), then restarts OpenMausBot.

On a first install it stops after step 4 with a note that the OpenMausBot service
doesn't exist yet; that's the next step. `admin/openmausbot-upgrade.sh --check`
(no `sudo` needed) shows the installed versions, whether browser and server
match, and the newest release with a match, without changing anything.

<details>
<summary>The same thing by hand (OpenMausBot 0.1.107)</summary>

```bash
sudo npm install -g openmausbot@0.1.107
sudo npm install -g @duckdb/node-api@1.5.6-r.1 @resvg/resvg-js@2.6.2
sudo mkdir -p /etc/systemd/system/openmausbot.service.d
printf '[Service]\nEnvironment=OMB_DUCKDB_DIR=/usr/lib\n' | \
  sudo tee /etc/systemd/system/openmausbot.service.d/duckdb.conf
```

For other releases, take the versions from
`https://raw.githubusercontent.com/milind-soni/OpenMausBot/v<version>/package.json`.
</details>

**Always upgrade OpenMausBot with the script**: a new release may pin new
native module versions, which `npm install -g openmausbot` alone won't install,
and the browser's DuckDB has to follow.

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
sudo /usr/local/src/omb-webreports/admin/openmausbot-upgrade.sh
systemctl show openmausbot -p Environment     # must include OMB_DUCKDB_DIR=/usr/lib
```

(After step 7 this is `sudo webdata-admin upgrade-openmausbot`.)

Pair your phone or browser with OpenMausBot now, as its docs describe. (After
step 7 isolates OpenMausBot, its CLI can no longer pair devices: pair from a
signed-in device, Settings → Remote access, or with `sudo webdata-admin pair`.
The web app shows a bot's threads only with Settings → General → Advanced mode
on, per browser.) Create a bot,
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

## 6. HTTPS for phones

Plain HTTP works on the tailnet, but iPhones treat it as insecure. Put
Tailscale's HTTPS in front before installing, so the installer can suggest the
right address (the port is your choice; 8443 keeps 443 free for OpenMausBot's
own `--tailscale` endpoint):

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080    # Apache, which the installer sets up
tailscale serve status
```

This keeps the site on your tailnet: `https://<machine>.<tailnet>.ts.net:8443`.
For pages on the internet, see [step 12](#12-optional-pages-on-the-internet);
never Tailscale Funnel on this port (it would open every report and database).

## 7. Install

```bash
sudo /usr/local/src/omb-webreports/admin/install.sh
```

The first run asks a few questions and writes the answers to
`/etc/omb-webreports/config.env` (root-owned). Press Enter to take a default:

| Question | Default |
|---|---|
| The user that runs OpenMausBot (`WEBREPORTS_OWNER`) | the user who ran `sudo` |
| Where your reports, published data and jobs live (`DATA_DIR`) | `/var/lib/omb-webreports` |
| Apache's port, on 127.0.0.1 (`LISTEN_PORT`) | `8080` |
| The address people open (`SITE_URL`) | the `tailscale serve` HTTPS address from step 6, if there is one |
| OpenMausBot's data folder, global node_modules | `~/.openmausbot`, `/usr/lib/node_modules` |
| Isolate OpenMausBot from local programs (`OMB_LOOPBACK_TRUST`) | `service` (yes) |

It also looks up the DuckDB-WASM build matching OpenMausBot's DuckDB
(`DUCKDB_WASM_VERSION`). Then it:

- checks the prerequisites (Node 20+, the two native modules, OpenMausBot's data
  dir) and that it's running from a root-owned source (otherwise it refuses;
  see [development](development.md));
- copies just what runs into **`/usr/local/lib/omb-webreports`**, owned by root:
  the tools, skills, report template, the agent docs and the shared site files;
- creates `DATA_DIR`, owned by you: `reports/`, `data/`, `jobs/` (Apache, and
  webdata-deploy's user, may read only `reports/` and `data/`);
- installs Apache and **dedicates it to this site**: it replaces
  `/etc/apache2/ports.conf` to listen only on `127.0.0.1:LISTEN_PORT`,
  disables the default site, and installs a hardened virtual host (see
  [architecture](architecture.md#security-model)). Don't run it on a machine
  whose Apache serves other sites;
- installs and starts two services running as you, sandboxed:
  `webdata-sync` (publishes bot databases) and `webdata-jobs` (scheduled jobs),
  and `webdata-notify` (root, locked down): alerts a bot when one of its jobs
  keeps failing (step 10);
- installs **wrangler** (Cloudflare's CLI, pinned by `deploy/package-lock.json`)
  and the `webdata-deploy` service with its own user, `omb-webreports-deploy`;
  the service starts once you set it up (step 12);
- points `tailscale serve` handlers that went to the old password gate at
  Apache (tailnet only, Funnel off), and removes what older versions had for
  passwords and the internet (`webdata-gate`, the site's own Tailscale node);
- **isolates OpenMausBot** (`OMB_LOOPBACK_TRUST=service`): programs on this
  machine, your bots' shells included, can no longer administer it without a
  login. webdata-skills gets a session of its own first, kept where only root
  can read it, plus a daily timer that keeps it valid;
- adds the Report builder preset to OpenMausBot and updates bots' copies of the
  skills (`webdata-skills sync`, step 9), if OpenMausBot is running;
- links the `webdata-*` tools into `/usr/local/bin` (including `webdata-admin`,
  for every later root task) and records what it installed (source and commit)
  in `/etc/omb-webreports/installed.json`.

`sudo admin/install.sh --print` shows every system file it writes, without
changing anything. Coming from the old layout (a checkout in your home folder
with its own `config.env`)? Add `--migrate-from ~/webdata`: it takes that
checkout's settings, reports, jobs and job history.

## 8. Settings and updates

Settings live in `/etc/omb-webreports/config.env`: edit it as root, then
re-run `sudo /usr/local/src/omb-webreports/admin/install.sh`. To update:

```bash
sudo webdata-admin update               # newest on the clone's branch
sudo webdata-admin update --ref v1.2.0  # a tag, branch or commit
```

It refuses if the clone isn't root-owned or has local changes, fast-forwards
it with git, then runs the (new) installer. `webdata-info` shows what's
installed and where it came from; `sudo webdata-admin status` also whether
GitHub has something newer.

## 9. Teach your bots the skills

Four skills in `skills/` teach a bot to read, create and update reports and to
schedule data jobs. Each bot keeps its own copy of a skill in OpenMausBot.
There are three ways to give a bot the skills.

**A new bot from the preset (recommended).** The install (step 7) added a
**Report builder** preset to OpenMausBot's New bot dialog: the four skills plus
standing instructions for report work. In the app: New bot → Report builder →
Create, then open the bot's skills and **turn each of the four on** (skills
added from a file always arrive switched off). The preset comes from
`skills/omb-webreports.openmaus.json`, an OpenMausBot package; you can also
import that file in the app yourself, or its GitHub link.

**An existing bot:**

```bash
sudo webdata-admin skills add Bramble     # the bot's name; adds the four skills, switched on
```

**Or by chat**, with OpenMausBot's `/learn` (you confirm each skill in the app):

```
/learn Create one skill per file with skill_manage, using each file's contents
exactly as written: /usr/local/lib/omb-webreports/skills/webdata-reports-read/SKILL.md,
/usr/local/lib/omb-webreports/skills/webdata-report-create/SKILL.md,
/usr/local/lib/omb-webreports/skills/webdata-report-update/SKILL.md and
/usr/local/lib/omb-webreports/skills/webdata-data-job/SKILL.md. Use the file path as the source.
```

However a bot got them, **updates are automatic**: `sudo webdata-admin update`
and `upgrade-openmausbot` finish with a skills sync, which replaces outdated
copies in every bot that has them (keeping each skill on or off as it was) and
swaps in the new release of the preset.
`sudo webdata-admin skills status` shows which bots have the skills and whether
they're current (`sudo` because, with OpenMausBot isolated, it uses a root-only
session).

Bots will ask for approval to read and write the content folder and to run the
`webdata-*` commands; allow them in the bot's settings if that gets tedious.

## 10. Job failure notifications

Nothing to do: `webdata-notify` sets up a webhook for each bot that a job's
`"notify_failure"` names, and new jobs name their own bot. See
[data-jobs.md](data-jobs.md#failure-notifications).

## 11. Verify everything

```bash
webdata-info                    # versions, paths, the services "active", browser DuckDB "same as the server",
                                # OpenMausBot isolation "on" with a session
sudo webdata-admin status       # also: updates available, bots' skills, failure alerts, published pages
webdata-check _gallery          # renders the design gallery on a headless iPhone: must print OK
```

Then open `SITE_URL/` on your phone: the front page lists your reports and
the published databases. Open `SITE_URL/reports/_gallery/` to see every
component. To install a report as an app: Safari → Share → Add to Home Screen.

Next: ask a bot to make its first report. Day-to-day use, logs and
troubleshooting are in [operations.md](operations.md).

## 12. Optional: pages on the internet

The site itself stays on your tailnet. Pages you choose can also go on the
internet: a static copy on [Cloudflare](https://www.cloudflare.com/) (a Worker
with static assets, free plan), so nothing on this machine is exposed and it
keeps working when this machine is off. `webdata-deploy`, a service, keeps the
copy current: when a published page or its data changes, it deploys within a
minute or two. Each page is published by a person, with `sudo`; bots can
update a published page but never publish another.

**Once: a Cloudflare account and a token.**

1. Sign up at https://dash.cloudflare.com/sign-up (the free plan is enough).
2. Open **Compute → Workers & Pages**. **Account details** (on the right) shows
   the **Account ID** (also in the address bar: `dash.cloudflare.com/<id>/…`)
   and your `workers.dev` **Subdomain**, which Cloudflare assigns (e.g.
   `you.workers.dev` → `https://<name>.you.workers.dev`; the pencil changes it).
   If there's no subdomain yet, it asks you to pick one there.
3. **Profile → API Tokens** (the person icon at the top right, or
   https://dash.cloudflare.com/profile/api-tokens) → **Create Token**, template
   **Edit Cloudflare Workers**. Under Account Resources choose your account; under Zone
   Resources, *All zones from an account* is fine (it's only used for custom
   domains). Create it and copy it (Cloudflare shows it once).

```bash
sudo webdata-admin deploy setup      # asks for the account ID, a name for the Worker, and the token
```

The Worker's name becomes the address: `https://<name>.<subdomain>.workers.dev/`.
The token is checked with Cloudflare, then kept in
`/etc/omb-webreports/deploy-secrets.json` (root only; the service gets it as a
systemd credential). The first deploy, a minute later, puts up the front page
only.

**Each page you want public:**

```bash
webdata-ls                                    # the reports and the databases each reads
sudo webdata-admin deploy add cary-today      # the page, plus the databases its report.json lists now
sudo webdata-admin deploy status              # the address, each page and its data, the last deploy
sudo webdata-admin deploy remove cary-today   # off the internet with the next deploy
```

A published page takes its databases with it, and anyone with the link can
download those whole (every table, not only what the page shows). When a bot's
database holds more than should be public, have the bot build a database just
for the page first. If a published page later starts reading another
database, the internet keeps its last published version until you `add` it
again (`deploy status` says so). The front page there lists only the published
pages and databases.

**A password (optional).** One password for the whole published site:

```bash
sudo webdata-admin deploy password set    # 12+ characters; asks twice
sudo webdata-admin deploy password off
```

Visitors then get a password form at the page they opened; the right password
sets a cookie for 400 days (HttpOnly, Secure, SameSite=Lax). On iPhone a
home-screen app keeps its own cookies, so it asks once inside the app too. A
new password signs every device out; `/_logout` signs one out. With a password,
every request runs the Worker (the free plan allows 100,000 a day; an open
report checks for new data every 15 seconds), and Cloudflare stores the
password as the Worker's secret.

`sudo webdata-admin deploy now` deploys without waiting; `deploy disable` stops
deploying (the site stays online as last deployed: delete the Worker in the
dashboard to take it down).
