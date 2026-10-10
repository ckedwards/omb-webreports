# DESIGN.md: the reports design system

How every report on this site looks, reads and behaves. READ_FIRST.md covers
the mechanics (data, kit API, files); this covers the design. Read both before
building a report.

**See it live:** SITE/reports/_gallery/
(source: `webroot/reports/_gallery/index.html`). Every component and chart
form below is rendered there with the real kit, in light and dark. Each chart
recipe is one function in the gallery source: **copy it, don't reinvent it.**

The pieces: `lib/kit.css` (tokens + components), `lib/kit.js` (helpers),
vendored Observable Plot for charts. The palette is a validated,
colorblind-safe set; don't add colors.

---

## 1. Principles

1. **Phone first.** Designed at ~390px wide, read with a thumb. Desktop is a
   bonus (the grid widens on its own).
2. **One question per report.** The title names the subject, the first screen
   answers the question, everything below supports it.
3. **The number is the hero.** If the story is one number, show a stat tile,
   not a chart. Charts earn their place by showing shape: change, rank, spread.
4. **Quiet chrome, loud data.** Hairline grids, muted axes, thin marks. Color
   is for data identity and meaning, never decoration.
5. **Same pieces everywhere.** Use the kit components as they are. A report
   that looks different from the others is wrong, even if it looks good.

## 2. Page anatomy

```
┌ app header ─────────────────────┐  ‹ back · title · "Data updated 3 min ago"
│ stat tiles (3–6)                │  .grid.stats: the answer, first screen
│ filter row (optional)           │  .filters: one row, scopes everything below
│ chart cards (2–6)               │  .grid: 1 column on phones, 2–3 on desktop
│ detail table (tabs if several)  │  .card with table(), the numbers behind the charts
└─────────────────────────────────┘
```

- Keep the template's `<head>` and `.app-header` exactly (home-screen app
  behaviour, status line, back link). Everything else goes in `<main>`.
- **Stat tiles:** 3 to 6. More than 6 means some aren't headline numbers;
  move them to a table.
- **Charts:** 2 to 6 cards. Use `.wide` on a card that needs width: long time
  series, small multiples, tables, heatmaps with many columns.
- **Filters** (period, category): one `.filters` row above the content it
  scopes, never inside a card. Every chart and tile below re-renders from the
  same filtered data.
- **Order:** answer → explanation → detail. Don't open with a table.
- A section title between groups (`<h2>` + muted `<p>`) is fine on long
  reports; most reports don't need one.

### Card anatomy

```html
<article class="card">
  <header><h2>Home run leaders</h2><p>Top 10</p></header>
  <div id="hr"></div>
</article>
```

- `h2`: what is shown, in plain words, sentence case. "Home run leaders",
  not "Bar chart of HR" and not "HOME RUNS".
- `header p` (muted, right-aligned): scope, units or how to read it.
  "Top 10", "Hitters with 150+ AB", "40+ innings · lower is better", "per game".
  Put units here once instead of on every value.

## 3. Tokens

Use tokens via `var(--name)` in CSS. Never write a hex value in a report.
Charts need resolved values: `const c = colors()` in kit.js, inside `render()`
(it re-runs on theme change).

| Token | `colors()` | Use |
|---|---|---|
| `--page` | `page` | page background |
| `--surface` | `surface` | cards, chart background, dot rings, segment gaps |
| `--surface-2` | | hover rows, tags, segmented control track |
| `--ink` | `ink` | primary text, values |
| `--ink-2` | `ink2` | secondary text, chart value labels, legend text |
| `--muted` | `muted` | notes, subtitles, axis text, timestamps |
| `--grid` | `grid` | gridlines, table row rules |
| `--axis` | `axis` | baselines, reference rules |
| `--border` | | card and input outlines |
| `--accent` | | links, focus (not for data) |
| `--series-1` … `--series-8` | `series[0..7]` | categorical data, **in this order** |
| `--status-good/-warning/-serious/-critical` | `good`, `warning`, … | state only, always with a label or icon |
| `--good-text`, `--bad-text` | | readable text color for good/bad deltas |
| `--seq-low` → `--seq-high` | `seqLow`, `seqHigh` | sequential magnitude (heatmaps) |
| `--div-neg`, `--div-mid`, `--div-pos` | `divNeg`, `divMid`, `divPos` | diverging (below/above a midpoint) |
| `--font`, `--mono`, `--radius`, `--gap` | | type, corner radius (12px), spacing (16px) |

Dark mode is a separate, validated set of the same tokens, not an
inversion. Note that the sequential ramp flips in dark mode (low = dark), so
"near zero" always recedes toward the surface. Never special-case dark mode in
a report; if something only works in one mode, it's using the wrong token.

## 4. Typography

System sans everywhere, including the big numbers (no display or serif fonts).

| Element | Size | Use |
|---|---|---|
| `h1` | 22px / 650 | report title (app header only) |
| `h2` | 16px | card title |
| `h3` | 14px, `--ink-2` | sub-heading inside a card |
| body | 15px (14px on phones) | |
| `.stat .value` | 28px (24px on phones) | headline number, proportional figures |
| `.secondary`, `.muted` | | supporting text, notes |
| `.num` | | `tabular-nums`, only for numbers that align in a column |

Sentence case for every title, label and button. No ALL CAPS, no Title Case,
no trailing colons on labels.

## 5. Components

All in kit.css / kit.js; the gallery shows each one.

**Stat tiles**: `stats(el, items)` into a `<section class="grid stats">`:

```js
stats($('stats'), [
  { label: 'Record', value: '79–83', note: '5th AL East · 19 GB' },
  { label: 'Team ERA', value: fmt.num(3.89, 2),
    delta: { text: '0.41 vs 2025', direction: 'down', good: true } },
  { label: 'Errors', value: '129',
    delta: { text: '12 vs 2025', direction: 'up', good: false } },
]);
```

`value` is display text (format it first). `delta.direction` sets the arrow
(▲ ▼ ■), `delta.good` sets the color (`true` green, `false` red, `null`
neutral). They're separate on purpose: "ERA down" is good. Say what the
delta is against ("vs last week").

**Segmented control**: tabs or a filter, one helper:

```html
<div class="segmented" role="group" aria-label="Period" id="period">
  <button data-value="30">30 days</button>
  <button data-value="90" aria-pressed="true">90 days</button>
</div>
```

```js
const period = segmented($('period'), { onChange: () => app.redraw() }); // filter
segmented($('table-tabs'));   // tabs: an element with id = data-value is a panel
// read the current choice inside render(): period.value
```

2 to 4 options with short labels. More options → a `<select>`.

**Tables**: `table(el, rows, columns, { sort, desc })`. Pick columns
deliberately (not every column in the table), give them short labels, format
every numeric column, and default-sort by the column that matters.
Numbers right-align automatically. Several tables → one card with
segmented tabs (see the example report).

**Legend**: `legend(el, [{ label, color, line? }])` above the chart, for 2+
series only. `line: true` for line charts (the key mirrors the mark).

**Empty state**: `empty(el, 'No games scheduled this week.')`. Say what's
missing in plain words; never leave a blank card or an empty chart frame.

**Loading and errors**: handled by `report()`. Content dims while
re-rendering, errors appear in a banner, and the status line shows freshness.
Don't add spinners or skeletons.

**Inputs**: `<select>` and `<input type="search">` are styled by kit.css; put
them in the `.filters` row.

## 6. Charts

### Pick the form first

| Question | Form | Gallery function |
|---|---|---|
| One headline value | stat tile (not a chart) | `headline()` |
| How did it change over time? | line | `trend()` |
| How do 2–4 things compare over time? | lines + legend | `compare()` |
| 5+ things over time | small multiples | `multiples()` |
| Who's on top? | horizontal bars, sorted | `ranking()` |
| How much per period? | columns | `columns()` |
| What's it made of, per period? | stacked columns (≤ 4 parts) | `stacked()` |
| Above or below target/zero? | diverging bars | `diverging()` |
| When does it happen (day × hour/week)? | heatmap | `heatmap()` |
| Do two measures relate? | scatter | `scatter()` |
| Exact values | table | `tables()` |

**Never** a dual-axis chart (two y scales): use two charts or index both to
100. **Never** a pie or donut for comparing close values; use bars.
No 3D, no gradients, no shadows on marks.

### Color

- One series → `c.series[0]` for every mark. Don't color bars by value.
- Categories → `c.series[0..7]` **in fixed order, pinned per entity**: set
  `color: { domain: [...] }` so filtering never repaints survivors. More than
  8 → fold the tail into "Other" or use small multiples. Scatters and other
  overlapping forms: 3 colors at most.
- Magnitude → sequential `[c.seqLow, c.seqHigh]`, with a scale legend.
- Above/below → `c.divPos` / `c.divNeg` around a neutral `c.divMid` or zero rule.
- Status colors only when the color *means* good/bad, and never alone.
- In light mode, series 3–5 (aqua, yellow, pink) are below 3:1 contrast on
  the surface: anything drawn in them needs direct labels or a table view.
- Text never takes a series color: labels and values use `c.ink2`/`c.muted`;
  identity comes from the colored mark beside the text.

### Marks (the house look)

| Mark | Spec | Plot |
|---|---|---|
| Bars | ≤ 24px thick, 4px rounded **data end**, square at baseline | horizontal `rx2: 4, insetTop: 4, insetBottom: 4`; vertical `ry1: 4` + `x: { padding: 0.35 }`; negative vertical `ry2: 4` |
| Lines | 2px | `strokeWidth: 2` |
| Dots | r ≥ 4 with a 2px surface ring | `r: 5, stroke: c.surface, strokeWidth: 2` |
| Area | 10% wash of the line color | `fillOpacity: 0.1` |
| Stacked segments | 2px surface gap, no borders | `stroke: c.surface, strokeWidth: 1` |
| Grid / axes | hairline, solid, recessive | `grid: true`, `ruleY([0], { stroke: c.axis })` |
| Heatmap cells | 2px gap, slight round | `inset: 1, rx: 3` |

### Labels

- Label selectively: bar tips, line ends, the extremes, the 2–3 points the
  story is about. Never a number on every point of a dense series.
- If every bar has its value at the tip, drop that axis (`axis: null`).
- End labels that would collide are dropped, not nudged apart; the legend
  and tooltip carry identity (see `compare()`).
- Scatter labels sit beside their dot, on the side away from the edge
  (see `scatter()`).
- Labels must never overlap axes or each other: give them room with margins
  or `insetTop`/`insetBottom` on the scale (see `diverging()`).
- Axis tick labels: round numbers, 4 ticks or so (`ticks: 4`),
  `tickFormat: fmt.compact` for big numbers, `fmt.rate`/`fmt.pct` for rates.
- Axis titles only when units aren't obvious from the card subtitle.

### Interaction

- Every chart gets hover tips: `tip: true` (or `tip: { format: {...} }`) on
  bars, dots and cells; a crosshair (`Plot.pointerX`) on lines that snaps to the
  nearest date. With several lines, one tooltip lists every series (see `compare()`).
- Tooltips enhance, never gate: every value is also in a label or a table.

### Sizing

| Form | Height | Margins |
|---|---|---|
| Horizontal bars | `rows * 28 + 8` | `marginLeft` ≈ 7px × longest label (≈ 130 for full names) |
| Lines, columns, stacked | 220 | `marginLeft: 36–40`; `marginRight: 36–52` for end labels |
| Heatmap | ~230 + legend | `marginLeft: 36` |
| Scatter | 240–250 | `marginBottom: 40` (axis title) |
| Small multiples | `n * 92 + 24` | facet labels inside panels |

Width is automatic (the card). Check at 390px: long category names become
the problem first; shorten them in SQL or the label function, never by
shrinking the font.

## 7. Words and numbers

- **Report title**: a noun phrase, ≤ 24 characters ("Blue Jays 2026").
  `short_name` (home screen) ≤ 12.
- **Description** (front page): one or two sentences saying what you'll learn.
- **Card titles**: what is shown; the subtitle says scope, units and how to
  read it ("lower is better").
- **Formatting** (always through `fmt`, never raw numbers):

| Kind | Helper | Example |
|---|---|---|
| Counts | `fmt.num(n)` | 1,284 |
| Big counts in tiles/axes | `fmt.compact(n)` | 12.9K |
| Fixed decimals | `fmt.num(n, 2)` | 3.89 |
| Percent from a fraction | `fmt.pct(x, 1)` | 48.8% |
| Rates conventionally without the leading 0 | `fmt.rate(x)` | .262 |
| Dates / date-times | `fmt.date`, `fmt.datetime` | Oct 10, 2026 |
| Relative time | `fmt.ago` | 3 minutes ago |
| Money | `Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })` | $4.2M (`notation: 'compact'`) |
| Missing | (fmt returns) | – |

- One precision per column; tiles ≤ 3 significant digits where possible.
- Ranges and records use an en dash: "79–83", "2024–2026". Text negatives
  use a real minus: "−2.5". Hyphenated values that must not wrap
  ("42-39") get non-breaking hyphens (`‑`).
- Name the comparison for every delta: "+12 vs last week", never a bare "+12".
- No exclamation marks, no emoji, no "Insights!"-style headings.

## 8. Icon and theme color

- `theme_color` (report.json): a mid-to-dark color tied to the subject (a
  team color, a brand color), used for the home-screen icon background and
  manifest. It is **not** used inside the page; the page uses tokens.
- `icon.svg`: 512×512 viewBox, full-bleed square in the theme color, one
  bold simple glyph in white or a light tint, centered, ≈ 60% of the
  canvas. No text longer than 2 characters, no transparency, no rounded corners
  (iOS rounds them), no thin strokes (it's shown at 60px).

## 9. Accessibility

- Every chart has its numbers in a table on the page (tabs are fine).
- Identity is never color alone: legends for 2+ series, labels, deltas with arrows.
- `aria-label` on every `.segmented` group and on sections that aren't
  labelled by a heading; `alt=""` on decorative images.
- Data text goes in with `textContent` (kit helpers do this).
- Touch targets ≥ 32px (kit components already are).

## 10. Before you call it done

- [ ] `webdata-check <slug>` prints OK.
- [ ] Looked at `light.png` **and** `dark.png`: nothing overlaps, clips or
      overflows; no empty cards; labels readable.
- [ ] First screen answers the report's question.
- [ ] 3–6 tiles, 2–6 charts, a table with the chart numbers.
- [ ] Every chart form is the one the table in §6 picks; no dual axes.
- [ ] Colors from `colors()`/tokens only; series in order, pinned by domain.
- [ ] All numbers through `fmt`; units in subtitles; deltas name their comparison.
- [ ] Titles sentence case; `short_name` ≤ 12; description reads well on the front page.
