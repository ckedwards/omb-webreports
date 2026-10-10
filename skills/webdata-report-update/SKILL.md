---
name: webdata-report-update
description: Change an existing report on the omb-webreports site. Fix a bug or broken chart, add/remove/rework sections, change wording, metadata or icon, or rename, hide or delete a report. Use when asked to edit, fix, improve, extend or remove a report page.
tags: reports, webdata, duckdb, charts
---

# Update a report on the omb-webreports site

**First run `webdata-info`.** It prints `ROOT` (the install directory) and
`SITE` (the site's URL); below, `ROOT/...` and `SITE/...` mean those. The
`webdata-*` commands are on `PATH`.

Reports live in `ROOT/webroot/reports/<slug>/` and are live as soon as a
file is saved. Open copies (including home-screen apps) reload themselves
within ~20 seconds when `index.html` changes, so every save is visible to
people right away. Work carefully and verify before you finish.

## 1. Understand before editing

```bash
webdata-ls <slug>        # link, files, the tables it uses
webdata-check <slug>     # baseline: current problems + screenshots
```

Read `report.json` and **all** of `index.html` before changing anything.
Read `ROOT/READ_FIRST.md` ("Rules for reports", "kit.js API") and
`ROOT/DESIGN.md` unless you already have them in context. For a new chart
or component, start from its function in
`ROOT/webroot/reports/_gallery/index.html`.

Note what the baseline check printed, so you can tell your problems from
pre-existing ones. If the person says it's broken on their phone, also run
`webdata-errors --since 1h`: errors from real devices are
reported to the server log.

## 2. Make the change

- Change only what was asked. Keep the template `<head>`, the `.app-header`
  with `<div data-kit-status>`, and the single `report({ databases, render })`
  structure.
- `render` stays idempotent (`replaceChildren`, never append).
- New data needed? Check `webdata-ls data`. If a table is missing,
  load it into your own bot database (`main` schema) with your data tools; it
  is published within seconds. Add the database name to `databases` in both
  `report.json` and the `report({ databases })` call if it's a new one.
- Try SQL first with `webdata-sql "<SQL>"`.
- Same rules as new reports: `<db>.main.<table>`, `ORDER BY`,
  `{ cache: false }` for non-deterministic SQL, kit components and chart
  recipes per DESIGN.md, colors from `colors()`/tokens, numbers through `fmt`,
  `textContent` for data, only `/lib/`. Match the report's existing style.
- Data refreshes need no edit: if the numbers are just stale, the cause is the
  data, not the page (see the `webdata-reports-read` skill).

Metadata (title, description, tags, theme color) is in `report.json`; the
home-screen label is `short_name`. Icon: edit `icon.svg` (512×512, full-bleed,
no transparency). Generated files (`manifest.webmanifest`, `icon-*.png`)
update themselves; never edit them.

## 3. Verify

```bash
webdata-check <slug>
```

It must print `OK` with no new problems. Open both screenshots (`light.png`,
`dark.png`) and confirm the change looks right and nothing else moved or
broke (labels overlapping, clipped text, empty cards). Run the DESIGN.md §10
checklist for anything you added.

## Rename, hide, delete

A report's URL is its directory name, and home-screen installs are bound to
that URL. Prefer changing `title`/`short_name` in `report.json` over renaming.

- **Rename** (only if asked for a new URL): `mv` the directory to the new
  kebab-case slug, run `webdata-sync --once`, check the new URL, and tell the
  person to re-add it to their home screen; the old icon will stop working.
- **Hide** from the front page without deleting: `mv` it to `_<slug>` (still
  reachable by URL, not listed).
- **Delete**: only after the person explicitly confirms, and say that any
  home-screen icon for it will stop working. `rm -r` the one directory, then
  `webdata-sync --once`.

Never touch other reports, `webroot/lib/`, `webroot/data/` or
`ROOT/admin/`. `lib/kit.js` and `lib/kit.css` are shared by every
report: change them only when the person explicitly asks, then run
`webdata-check` on **every** report (`webdata-ls reports`) and on `_gallery`,
and update DESIGN.md if the change affects it.

## 4. Report back

Say what changed in a sentence or two, give the link
`SITE/reports/<slug>/`, and note that open
copies refresh on their own.
