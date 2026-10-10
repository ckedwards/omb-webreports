---
name: webdata-report-create
description: Create a new report page on the omb-webreports site, a self-contained mobile web app with stat tiles, charts and tables that reads live DuckDB data and can be saved to an iPhone home screen. Use when asked to make, build or publish a report, dashboard, scorecard or page from bot data.
tags: reports, webdata, duckdb, charts
---

# Create a report on the omb-webreports site

**First run `webdata-info`.** It prints `ROOT` (the install directory) and
`SITE` (the site's URL); below, `ROOT/...` and `SITE/...` mean those. The
`webdata-*` commands are on `PATH`.

A report is one directory, `ROOT/webroot/reports/<slug>/`, served at
`SITE/reports/<slug>/`. It queries the bots'
published DuckDB snapshots in the browser and updates itself when the data
changes. There is no build step and nothing to deploy: files on disk are live.

## 1. Learn the system first

Read `ROOT/READ_FIRST.md` (mechanics, `kit.js` API) and
`ROOT/DESIGN.md` (layout, tokens, components, chart forms, words and
numbers) completely; neither is repeated here. Then open the references:
- `ROOT/webroot/reports/_gallery/index.html`: every component and chart
  form as one function each (`trend`, `compare`, `ranking`, `columns`,
  `stacked`, `diverging`, `heatmap`, `scatter`, `multiples`). Copy from it.
- `ROOT/examples/reports/blue-jays-2026/index.html`: a complete real report.

## 2. Make sure the data is published

```bash
webdata-ls data
```

A bot's own tables (`main` schema of its database) are published
automatically as `<botname>.duckdb` within a few seconds of any change. If the
report needs data that isn't there yet, load it into your own database first
with your normal data tools (a `main`-schema table with clear column names and
proper types: numbers as numbers, dates as DATE/TIMESTAMP), then run
`webdata-ls data` again until it appears.

Explore it with the same SQL the browser will run:

```bash
webdata-sql "SELECT * FROM <db>.main.<table> LIMIT 20"
```

## 3. Plan before writing

Write down, for yourself, following DESIGN.md §2 and §6:
- the question the report answers and who reads it (on a phone);
- 3 to 6 stat tiles that answer it on the first screen;
- 2 to 6 charts, each with its SQL and the form the DESIGN.md §6 table picks
  (never a dual axis);
- the detail table(s) holding the charts' numbers.

## 4. Scaffold

```bash
webdata-new-report <slug> "<Title>" <database> "<one-sentence description>"
```

`<slug>` is lowercase-kebab-case and becomes the URL; pick it carefully
because renaming later breaks home-screen installs. This writes `index.html`
(a working table explorer to replace), `report.json` and a default icon.

## 5. Write the report

Edit `webroot/reports/<slug>/index.html`:
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
- Use only `/lib/` and the vendored d3/Plot. No other libraries or CDNs.

Edit `report.json`: `title`, `short_name` (12 characters or fewer, the
home-screen label), `description` (shown on the front page), `databases`,
`tags`, `theme_color`.

Optionally replace `icon.svg` (DESIGN.md §8): 512×512 viewBox, full-bleed
square in the theme color, one bold glyph, no transparency, no rounded corners.
PNG icons and the manifest are generated for you.

Don't touch `webroot/lib/`, `webroot/data/`, other reports, generated files
(`manifest.webmanifest`, `icon-*.png`, `initial.json`, `index.json`) or `ROOT/admin/`.

## 6. Verify, then look

```bash
webdata-check <slug>
```

It must print `OK`. Fix every reported problem (kit error, page error,
overflow, report.json warning) and run it again. Then open **both**
screenshots it saved (`light.png`, `dark.png`) and check what the tool can't:
overlapping or clipped labels, unreadable colors, empty sections, numbers
that look wrong. Compare a few numbers against `webdata-sql`. Go through the
DESIGN.md §10 checklist. Repeat until it is right.

## 7. Hand it over

Reply with the link `SITE/reports/<slug>/`,
one line on what it shows, and: "On iPhone: open in Safari → Share → Add to
Home Screen." It's also listed on the front page,
SITE/.
