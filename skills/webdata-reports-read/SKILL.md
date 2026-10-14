---
name: webdata-reports-read
description: Find, list, open, summarize or check reports on the omb-webreports site and the published data they use. Use when asked what reports exist, what a report shows, for a report's link, whether a report's data is current, or what data is available for reports. Read-only.
tags: reports, webdata, duckdb
---

# Read reports on the omb-webreports site

**First run `webdata-info`.** It prints `SITE` (the site's URL), `REPORTS`
(where reports live), `JOBS` (scheduled data jobs), `DATA` (the published
databases and `catalog.json`) and `DOCS` (read-only: READ_FIRST.md, DESIGN.md,
examples); below, `REPORTS/...`, `SITE/...` and so on mean those. The
`webdata-*` commands are on `PATH`. The shared code and docs are root-owned:
you can read them, not change them.

The reports site is static files, served at **SITE/** (Tailscale only). Each report is a
directory `REPORTS/<slug>/` and a page at `/reports/<slug>/`. Reports
read DuckDB snapshots of each bot's data in `DATA/<bot>.duckdb`, which
a sync service refreshes within seconds of the bot's data changing.

This skill only reads. Never edit, move or delete anything here; for changes
use the `webdata-report-update` or `webdata-report-create` skill.

## What exists

```bash
webdata-ls              # every report + every database (main tables)
webdata-ls <slug>       # one report: link, description, files, tables it uses
webdata-ls data         # every table with columns and types
```

Give people the full HTTPS link, `SITE/reports/<slug>/`,
and mention that on an iPhone, Safari → Share → Add to Home Screen installs it
as an app. That link works on the person's tailnet. Pages a person published
to the internet are also at `PUBLIC/reports/<slug>/` (`webdata-deploy status`
lists them and the address): give that one to someone outside the tailnet. If
the published site has a password, say it asks once per device; you don't
have it.

## What a report shows

1. `cat REPORTS/<slug>/report.json` for title, description and databases.
2. Read `REPORTS/<slug>/index.html`. The content is built in
   the `render(db)` function: each `db.query(...)` is the SQL behind a section,
   and the `chart(...)` / `table(...)` / stat calls show how it is presented.
3. To see it as a person would: `webdata-check <slug>` renders it at
   iPhone size in light and dark mode, prints problems, and saves
   `light.png` / `dark.png`. Open the screenshots to describe the layout.

## Numbers behind a report

Run the report's own SQL (or any SQL) against the same snapshots the browser uses:

```bash
webdata-sql "SELECT player, HR FROM mybot.main.batting_stats ORDER BY HR DESC LIMIT 5"
webdata-sql --json "SELECT ..."
```

Tables are named `<database>.main.<table>`. The `omb_results` schema holds a
bot's cached card results; ignore it.

## Is the data current?

- `webdata-ls` shows "data Xm ago" per report: when its snapshot last changed.
  A snapshot changes only when the bot's data changes, so an old time can
  simply mean nothing new was loaded.
- Open reports refresh themselves within ~20 seconds of new data; nobody needs
  to reload.
- If a bot's data changed but the snapshot did not, the sync service may be
  down: `systemctl is-active webdata-sync` and
  `journalctl -u webdata-sync -n 30 --no-pager`. Report that to the person;
  restarting it needs their sudo.

## Reference

`DOCS/READ_FIRST.md` explains the whole system (data flow, report
format, kit API, rules) and `DOCS/DESIGN.md` the design system; the
live component/chart gallery is at
SITE/reports/_gallery/. Read them when a
question goes beyond listing and describing reports.
