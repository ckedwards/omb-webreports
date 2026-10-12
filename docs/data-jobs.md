# Scheduled data jobs

A data job refreshes a bot's tables on a schedule by running a **script**
(no AI at run time). The usual flow:

1. Ask a bot to collect some data ("get the current standings into a table").
2. Ask it to keep it fresh: *"Create a cron task to update this data hourly."*
3. The bot (with the `webdata-data-job` skill) writes a script that reproduces
   the collection, tests it, shows you the script and schedule, and enables it
   after you say yes.

From then on `webdata-jobs` runs it on schedule; reports built on that data
update themselves.

## Anatomy of a job

```
JOBS/<name>/           (JOBS: /var/lib/omb-webreports/jobs; webdata-info --jobs)
  job.json    what, when, where to
  run.py      the script (or run.mjs / run.sh / an executable "run")
  .env        optional secrets, KEY=value, chmod 600
```

```json
{
  "description": "Standings from the league API",
  "bot": "MyBot",
  "schedule": "7 * * * *",
  "timezone": "America/Toronto",
  "enabled": true,
  "timeout_minutes": 10,
  "tables": {
    "standings":  { "mode": "replace" },
    "daily_runs": { "mode": "upsert", "key": ["team", "date"] }
  }
}
```

- `schedule`: 5-field cron (`minute hour day month weekday`), also
  `@hourly`/`@daily`/`@weekly`/`@monthly`; evaluated in `timezone` (IANA,
  default UTC) including DST changes.
- table `mode`: `replace` (the table is the current state), `upsert` (history:
  rows with the same `key` are replaced, others added), `append` (immutable events).
- per table: `min_rows` (default 1), `allow_schema_change` (replace only; default false).

The script writes one file per declared table into `$WEBDATA_OUT`
(`<table>.json` array of objects, `.ndjson`, `.csv` or `.parquet`) and exits 0.

## What happens on a run

1. The script runs in the job folder with a timeout, output logged. It
   starts a fixed number of seconds (0–50) into its scheduled minute, worked
   out from the job's name, so jobs due in the same minute start spread out
   rather than all at once. `webdata-job list` shows it as `next: … +29s`.
2. Every declared table is loaded and checked: present, at least `min_rows`
   rows, upsert keys unique and non-null, **columns and types unchanged** from
   the current table (reports depend on them).
3. The runner waits until OpenMausBot isn't holding the bot's database (it keeps
   it open 10 minutes after use), then applies all tables in one transaction,
   typically holding the file for milliseconds.
4. `webdata-sync` republishes the snapshot; open reports update.

Any failure at any step writes nothing; the previous data stays.

Jobs run inside the `webdata-jobs` sandbox: only the content folder (`/var/lib/omb-webreports`), OpenMausBot's
`bots/` folder and a private `/tmp` are writable. Scripts use the Python
standard library or Node built-ins (no package installs). For pages that need
JavaScript to render, scripts call `webdata-browse`, which runs headless Chrome
with a fresh profile per call. That costs ~1 s and a few CPU-seconds per call,
so prefer an API or file over a browser, and keep browser calls per run few. Limits worth adding if
browser jobs multiply are in
[future-work.md](future-work.md#browser-use-in-scheduled-jobs).

## Commands

```bash
webdata-job list                     # every job: enabled, schedule, last result, next run
webdata-job show <name>              # job.json, validation, next 5 runs
webdata-job run <name> --dry-run     # collect + validate, write nothing
webdata-job run <name>               # run now, for real
webdata-job logs <name> [--all]      # last run's log (or the list of runs)
webdata-job enable|disable <name>
webdata-job new <name> --bot <bot> --table <t>[:mode[:key,key]] --schedule "<cron>" --tz <zone>
```

Editing `job.json` takes effect at the next minute; no restart.

## When a job fails

`webdata-job list` shows `FAILED` (with a count if it repeats);
`webdata-job logs <name>` shows why. Typical causes: the source was down
(temporary; nothing to fix), the source changed its URL, layout or columns,
or returned a value the script didn't expect. Ask the bot that owns the job to
fix it ("job <name> failed, fix it"): its skill covers diagnosing, fixing the
script, dry-running and one real run, and tells it not to change the schedule or
loosen checks without asking you.

## Failure notifications

The bot can be told on its own. With `"notify_failure": "<bot>"` in a job's
`job.json` (`webdata-job new` sets it to the job's bot; any bot may be named,
say one that looks after all jobs), a failing **scheduled** run starts a task
in that bot. The bot gets the job, how long it has been failing, network and
source checks and the end of the log, and follows its skill: wait out an
outage, fix a broken script, or, if the source seems gone, **propose** an
alternate source to you. It doesn't change the schedule or switch sources
without your OK.

Alerts wait until a failure is worth a task. A script exits **75** when its
source can't be reached (DNS or connection errors, timeouts, HTTP 429/5xx;
the skill and the script template do this) and any other code when the source
answered but not as expected:

| Failure | Alert |
|---|---|
| broken (any exit code but 75) | after 2 failed runs in a row |
| temporary (exit 75, timeout, the bot's database busy too long) | once it has lasted `notify_after` (default `12h`) |
| temporary for `assume_gone_after` (default `3d`) | again, as "the source may be gone" |
| still failing | a reminder at most once a day; a worse stage at once |
| this machine's internet was down, or most other jobs are failing temporarily too | none (held) |
| the last run was manual | none (someone is working on it) |

`notify_after` and `assume_gone_after` take `30m`, `6h`, `2d`, `1w`. After a
failed scheduled run, the runner checks two well-known hosts and the job's
source hosts (`"sources": [...]` in job.json, else the URLs in its script) and
logs the result (`checks:` in the run log).

Nothing to set up: **`webdata-notify`**, a service the installer adds, creates
one OpenMausBot webhook per bot that jobs name ("omb-webreports job
failures"), sends it a test alert, and deletes it 10 minutes after no job
names that bot. It runs as root, so the webhooks' secrets stay where bots
(which run as you) can't read them, in `/var/lib/omb-webreports-notify/private/`.

```bash
webdata-job list                  # each job's "alerts:" line
webdata-notify status             # webhooks per bot, each job's alert state
webdata-job notify-test <name>    # the job's bot should get a test task within a minute
journalctl -u webdata-notify -f
```

If a webhook is turned off in OpenMausBot, alerts for it pause until you turn
it back on. Deleting it there makes the service create a new one.
