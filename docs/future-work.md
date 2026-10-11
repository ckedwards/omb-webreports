# Future work

Improvements that have been thought through but deliberately not built yet,
with the measurements behind that decision and the signs that it's time to
build them. Numbers were measured on the reference machine (a small Intel NUC,
Ubuntu 26.04) in October 2026.

- [Replay baked queries instead of re-rendering in Chrome](#replay-baked-queries-instead-of-re-rendering-in-chrome)
- [Browser use in scheduled jobs](#browser-use-in-scheduled-jobs)

## Replay baked queries instead of re-rendering in Chrome

### Today

Every time a report's data changes, `webdata-bake` opens the report in headless
Chrome, runs its first render with DuckDB-WASM, and saves the rows to
`initial.json` (see [architecture: baked first render](architecture.md#design-decisions)).

| Per bake (Blue Jays report) | Wall time | CPU | Memory |
|---|---|---|---|
| Chrome bake | ~2.2 s | ~5 CPU-seconds | up to ~500 MB, briefly |
| Native replay of the same 3 queries | 8–13 ms | negligible | none extra (sync already holds DuckDB) |

Most of a Chrome bake is DuckDB-WASM compiling inside the page, plus Chrome
starting. The CPU figure is above the wall time because Chrome spreads work
over several processes and threads.

### The idea

Bakes mostly happen because **data** changed, not the page, and then running
the page again isn't necessary: the SQL it runs is the same as last time.

1. **Page or `kit.js` changed (rare):** full Chrome bake, as today. kit also
   records the exact list of SQL statements the first render ran.
2. **Only data changed (common):** `webdata-sync` re-runs those recorded
   statements against the new snapshot with the native DuckDB it already has
   loaded, and writes `initial.json` itself. No browser, no report code.

This can't serve wrong data, because baked rows are looked up by exact SQL plus
database ETags. If new data would make the report issue different SQL (a new
table name in a dropdown, say), the browser finds no baked entry for it and runs
that query live. The worst case is a missed shortcut.

Two safeguards it would need:

- **Same results as the browser.** The browser and the server run the same
  DuckDB engine version (see [architecture](architecture.md#design-decisions)),
  but a pin can lag after `--skip-browser-check`, and kit converts values
  (DECIMAL, BIGINT, dates, lists, structs) in its own way. On every Chrome bake,
  sync would also run the SQL natively, convert it the same way, and compare. A report whose
  results differ stays on Chrome-only bakes, so each report checks itself.
- **No file access from SQL.** In the browser, report SQL can't reach the
  server's files; natively it could (`read_csv('/home/…')`, `COPY … TO`).
  Attach read-only, then `SET enable_external_access = false` and
  `SET lock_configuration = true` before running any recorded statement.

Side benefit: replays are cheap enough to drop most of the 5-second settle
delay, so a bake would be current within the same 3-second check that publishes
the snapshot. Today it's ~7 s, the window in which a visitor can see the
"Updating…" swap.

Estimated size: ~100–150 lines (recording in kit, replay and comparison in sync)
plus tests.

### Why not yet

At today's load the savings are too small to justify the code:

| Workload | Chrome bakes | With replay |
|---|---|---|
| One report, an hourly job (today) | ~5 CPU-s per hour | ~0 |
| 10 reports, hourly jobs | ~50 CPU-s per hour (~1.4% of one core) | ~0 |
| 10 reports, a bot writing every minute | ~14% of a core continuously, ~500 MB spikes every minute | ~0 |

Viewers wouldn't notice a difference: both approaches produce the same
`initial.json`, so pages load equally fast.

**Build it when** the sync log (`journalctl -u webdata-sync | grep bake:`) shows
bakes every few minutes, you have many reports on frequently written data, or
the ~7 s until a bake is current starts to matter.

### Rejected: running reports in Node with happy-dom, jsdom or Bun

Running the report script against a simulated DOM, with `query()` sent to native
DuckDB, would cut a bake to a few hundred milliseconds. It isn't worth it:

- **Security.** Report pages are written by bots, so they're untrusted. In
  Chrome they run inside its sandbox. A simulated DOM runs them inside Node's
  process, and Node's VM contexts aren't isolated: happy-dom's
  [CVE-2025-61927](https://nvd.nist.gov/vuln/detail/CVE-2025-61927) was page
  script escaping to run arbitrary code, and happy-dom has disabled script
  execution by default since version 20. A bad report would get everything the
  sync service has: read access to your home folder (OpenMausBot's data and
  secrets) and write access to the checkout.
- **Fidelity.** Native DuckDB plus a copy of kit's value conversion might not
  match the browser exactly, and would need the same checking as above anyway.
- **Coverage.** Plot, layout sizes and `getComputedStyle` are stubs in a
  simulated DOM, so many reports would fail to bake.

The replay design gets nearly all of the speed without running report code
outside a browser.

## Browser use in scheduled jobs

### Today

Job scripts render JavaScript-only pages with `webdata-browse`. Each call starts
a fresh headless Chrome with an empty, throwaway profile, so nothing is cached
between calls.

| Per `webdata-browse` call | Wall time | CPU |
|---|---|---|
| A trivial page (a small JSON file) | ~1.1 s | ~2.8 CPU-seconds |

Almost all of that is starting and stopping Chrome. A real site with scripts,
images and ads costs more time, CPU and memory, and downloads all of its assets
on every call.

Three things can stack up:

- **Calls per run.** A script that loops over pages and calls `webdata-browse`
  for each one starts a new Chrome per page.
- **Jobs at the same minute.** The scheduler (`webdata-job daemon`) starts each
  job a fixed 0–50 s into its minute (from the job's name), which spreads out
  start-ups. But there's no limit on how many run at once: browser jobs that
  take longer than the gap between their start times still overlap.
- **The bake that follows.** A job that changes data triggers a snapshot and then
  a Chrome bake of every report using it, shortly after the job's own browsers.

The `webdata-sync` and `webdata-jobs` services run at `Nice=10` but have no CPU
or memory limits, so a burst competes with OpenMausBot and Apache.

### Why not yet

- There are no jobs yet, and most sources won't need a browser: the
  `webdata-data-job` skill lists APIs, CSV/JSON files and plain HTML ahead of
  `webdata-browse`, and tells bots to look for the API a page calls before
  rendering it.
- Jobs due in the same minute already start spread across it (0–50 s, fixed
  per job), and the skill steers schedules off minute 0 ("hourly" →
  `7 * * * *`), which spreads them across the hour.
- A typical browser job makes one call per run: a few CPU-seconds per run.

### Ideas, most valuable first

1. **One browser per job run.** Let `webdata-browse` take several URLs (or keep
   one Chrome for the life of the script), so a multi-page scrape pays the
   start-up once. Update the skill to use it when a script needs more than one page.
2. **Shared browser slots.** One lock with a small number of slots (say 2),
   taken by both `webdata-browse` and `webdata-bake`, so browsers queue instead
   of piling up. Waiting would count against a job's `timeout_minutes`, so the
   wait needs its own budget or a clear log line.
3. **Resource limits.** `MemoryHigh`/`MemoryMax` and `CPUWeight` on the
   `webdata-jobs` and `webdata-sync` units (in `admin/install.sh`), so a runaway
   Chrome can't starve OpenMausBot or Apache.
4. **A cache per job.** Give each job its own persistent browser profile with a
   disk cache, so heavy pages don't re-download their scripts and images every
   run. This gives up some of the clean-slate isolation of a fresh profile, so
   only do it for sources that need it.

**Build them when** `webdata-job list` or `webdata-job logs` show runs getting
close to their timeout, jobs fail with timeouts mainly when other jobs run at the
same time, or the machine slows down around popular schedule minutes.
