---
name: webdata-report-create
description: Create a new page on the omb-webreports site, a self-contained mobile web app that reads live DuckDB data, updates itself and can be saved to an iPhone home screen. Two shapes, an analysis report (stat tiles, charts, tables) or a briefing of current items from several sources (news, weather, scores, events). Use when asked to make, build or publish a report, dashboard, scorecard, briefing or page from bot data.
tags: reports, webdata, duckdb, charts
---

# Create a report on the omb-webreports site

**First run `webdata-info`.** It prints `SITE` (the site's URL), `REPORTS`
(where reports live), `JOBS` (scheduled data jobs), `DATA` (the published
databases and `catalog.json`) and `DOCS` (read-only: READ_FIRST.md, DESIGN.md,
examples); below, `REPORTS/...`, `SITE/...` and so on mean those. The
`webdata-*` commands are on `PATH`. The shared code and docs are root-owned:
you can read them, not change them.

A report is one directory, `REPORTS/<slug>/`, served at
`SITE/reports/<slug>/`. It queries the bots'
published DuckDB snapshots in the browser and updates itself when the data
changes. There is no build step and nothing to deploy: files on disk are live.

## 1. Learn the system first

Read `DOCS/READ_FIRST.md` (mechanics, `kit.js` API) and
`DOCS/DESIGN.md` (layout, tokens, components, chart forms, words and
numbers) completely; neither is repeated here. Then open the references:
- `DOCS/webroot/reports/_gallery/index.html`: every component and chart
  form as one function each (`trend`, `compare`, `ranking`, `columns`,
  `stacked`, `diverging`, `heatmap`, `scatter`, `multiples`; for briefings
  `conditions`, `headlines`, `forecastChart`, `recentResults`). Copy from it.
- `DOCS/examples/reports/blue-jays-2026/index.html`: a complete real report.

## 2. Pick the shape

- **Analysis report**: answers a question from data that has been collected,
  with stat tiles, charts and tables ("how are the Blue Jays doing").
- **Briefing**: current items from several sources on one page, each section
  refreshed on its own schedule ("Cary today: news, weather, the local team's
  results").

If the request is ambiguous, ask which one they mean. DESIGN.md §2 describes both.

## 3. Make sure the data is published

```bash
webdata-ls data
```

A bot's own tables (`main` schema of its database) are published
automatically as `<botname>.duckdb` within a few seconds of any change. If the
report needs data that isn't there yet, load it into your own database first
with your normal data tools (a `main`-schema table with clear column names and
proper types: numbers as numbers, dates as DATE/TIMESTAMP), then run
`webdata-ls data` again until it appears.

For a **briefing**, collect each source into its own table (`cary_news`,
`cary_weather`, `cary_results`), scraping pages if that's where the data is:
- keep only current items (today's headlines, the coming forecast, recent
  results), so the page doesn't filter by date;
- give every row a `fetched_at` TIMESTAMP: when you collected it, in UTC, the
  same value on every row of that collection. The page shows it as "Updated 12
  minutes ago";
- links as absolute `http(s)` URLs (resolve relative links against the page
  you scraped);
- choose the columns carefully now: the data job that keeps the table fresh
  (step 8) must write exactly the same columns and types.

Explore it with the same SQL the browser will run:

```bash
webdata-sql "SELECT * FROM <db>.main.<table> LIMIT 20"
```

## 4. Plan before writing

Write down, for yourself, following DESIGN.md §2 and §6.

An analysis report:
- the question the report answers and who reads it (on a phone);
- 3 to 6 stat tiles that answer it on the first screen;
- 2 to 6 charts, each with its SQL and the form the DESIGN.md §6 table picks
  (never a dual axis);
- the detail table(s) holding the charts' numbers.

A briefing:
- the sections, one card per source, in the order the reader checks them;
- for each: its table, its SQL, `feed()` / a small chart / a table, its empty
  message, and its `staleAfter` (about 3 × how often it will be refreshed);
- 0 to 4 stat tiles for the at-a-glance numbers (temperature now, next game).

## 5. Scaffold

```bash
webdata-new-report <slug> "<Title>" <database> "<one-sentence description>"
```

`<slug>` is lowercase-kebab-case and becomes the URL; pick it carefully
because renaming later breaks home-screen installs. This writes `index.html`
(a working table explorer to replace), `report.json` and a default icon.

## 6. Write the page

Edit `REPORTS/<slug>/index.html`:
- Keep the whole `<head>` from the template (error reporter, home-screen meta
  tags, kit.css, the `<!-- webdata:modules -->` block, preconnect, `defer`
  scripts) and the `.app-header` with the back link and `<div data-kit-status>`.
  Change only `<title>` and `apple-mobile-web-app-title`. Never edit the
  `webdata:modules` block or the `?v=…` on `/lib/` URLs; the sync maintains
  them (they keep iPhones from running a stale cached kit, and let browsers
  cache shared code).
- Put all content inside `<main>`; use the kit components exactly as
  DESIGN.md §5 shows (`stats()`, `segmented()`, `table()`, `legend()`,
  `empty()`, `.card` with `header h2` + `p`).
- All logic goes in one `report({ databases: [...], async render(db) {...} })`.
  `render` must be idempotent: build with `replaceChildren`, never append;
  it runs again on data, theme and resize changes.
- SQL: qualify as `<db>.main.<table>`, `ORDER BY` whenever order matters,
  and use `db.query(sql, { cache: false })` for anything using `now()`,
  `random()` or another URL.
- Charts via `chart(el, plotOptions)` with colors from `colors()`, starting
  from the gallery function for that form; follow DESIGN.md §6 (colors,
  marks, labels, tips, sizing).
- Words and numbers per DESIGN.md §7: sentence-case titles, units in the card
  subtitle, every number through `fmt`, deltas name their comparison.
- Insert data text with `textContent` only; never `innerHTML` with data.
- Briefings: lists through `feed()`, which is the only place links are made
  from data (it accepts absolute `http(s)` URLs only; never set an `href` from
  data yourself). Each card's header `<p>` gets
  `freshness(el, newestFetchedAt, { staleAfter })`. No images from sources.
  Start from the gallery's briefing recipes (`headlines`, `forecastChart`,
  `recentResults`, `conditions`).
- Use only `/lib/` and the vendored d3/Plot. No other libraries or CDNs.

Edit `report.json`: `title`, `short_name` (12 characters or fewer, the
home-screen label), `description` (shown on the front page), `databases`,
`tags`, `theme_color`.

Optionally replace `icon.svg` (DESIGN.md §8): 512×512 viewBox, full-bleed
square in the theme color, one bold glyph, no transparency, no rounded corners.
PNG icons and the manifest are generated for you.

Don't touch `DATA/`, other reports or generated files (`manifest.webmanifest`,
`icon-*.png`, `initial.json`, `index.json`). The shared code and docs are
read-only.

## 7. Verify, then look

```bash
webdata-check <slug>
```

It must print `OK`. Fix every reported problem (kit error, page error,
overflow, report.json warning) and run it again. Then open **both**
screenshots it saved (`light.png`, `dark.png`) and check what the tool can't:
overlapping or clipped labels, unreadable colors, empty sections, numbers
that look wrong. Compare a few numbers against `webdata-sql`. Go through the
DESIGN.md §10 checklist. Repeat until it is right.

## 8. Keep it fresh

Data you collected once goes stale. Use the **webdata-data-job** skill to turn
each collection into a scheduled script:
- **Briefing**: required, or the page is out of date by tomorrow. One job per
  source when they change at different rates (weather every 30 minutes, news
  hourly, results daily), each table in `replace` mode, each writing
  `fetched_at`. Propose the jobs and schedules in your reply and create them
  once the person agrees (the data-job skill has the steps and the approval).
- **Analysis report**: offer it when the data came from an outside source that
  keeps changing ("keep the stats updated daily?"): `upsert` for history,
  `replace` for current totals.

Skip this when the data only changes when the person asks you to change it.

## 9. Who can see it

`webdata-access status` shows who can reach the site (your tailnet only, or
the whole internet through Tailscale Funnel) and each database's and report's
access. Access belongs to a **database**: making `cary-news` private makes its
file, its other files and every report that reads it (its `report.json`
`databases`) private. So `databases` must list every database the page reads.

- **Reachable from your tailnet only**: don't ask about passwords; the person
  can bring it up.
- **Reachable from the internet** and the report's database is public: ask
  before handing it over: "This site is open to the internet. Keep the report
  public, or make <database> private with a password? (It also covers <other
  reports that read it>.)" Then, as they choose:

```bash
webdata-access set <database> <<'EOF'
<the password they gave, 12+ characters>
EOF
```

Take the password from the person; never make one up, and never repeat it in
your reply or anywhere else (not in files, notes or memory). If it's too
short, say so and ask for a longer one (a few words work well).

## 10. Hand it over

Reply with the link `SITE/reports/<slug>/`,
one line on what it shows, the data jobs that keep it fresh (or the ones you
propose, waiting for a yes), and: "On iPhone: open in Safari → Share → Add to
Home Screen." If it's private: it asks for the password once per device (and
once inside the home-screen app, which keeps its own sign-in). Public reports
are also listed on the front page, SITE/; private ones only for devices
that have signed in.
