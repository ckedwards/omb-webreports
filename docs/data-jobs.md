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
jobs/<name>/
  job.json    what, when, where to
  run.py      the script (or run.mjs / run.sh / an executable "run")
  .env        optional secrets, KEY=value, chmod 600 (git-ignored)
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

1. The script runs in the job folder with a timeout, output logged.
2. Every declared table is loaded and checked: present, at least `min_rows`
   rows, upsert keys unique and non-null, **columns and types unchanged** from
   the current table (reports depend on them).
3. The runner waits until OpenMausBot isn't holding the bot's database (it keeps
   it open 10 minutes after use), then applies all tables in one transaction,
   typically holding the file for milliseconds.
4. `webdata-sync` republishes the snapshot; open reports update.

Any failure at any step writes nothing; the previous data stays.

Jobs run inside the `webdata-jobs` sandbox: only the checkout, OpenMausBot's
`bots/` folder and a private `/tmp` are writable. Scripts use the Python
standard library or Node built-ins (no package installs). For pages that need
JavaScript to render, scripts call `webdata-browse`, which runs headless Chrome
with a fresh profile per call.

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

The runner can start that conversation itself. When a **scheduled** run fails,
it POSTs the job name, error and the end of the log to an OpenMausBot webhook
(on the first failure, then at most once a day while it keeps failing). The bot
gets a task with the details and fixes the job, asking for your approvals as
usual.

1. In OpenMausBot, create a **webhook** for the bot that runs a task, with a
   prompt such as:

   > A scheduled data job failed; the event data has the job, error and log
   > tail. Follow "Fixing a failed job" in the webdata-data-job skill: find the
   > cause, fix the script with the smallest change, dry-run, then one real run.
   > Don't change the schedule, tables or checks, or disable the job, without
   > asking me. Report what failed and what you changed.

2. Register its URL (it contains the secret) for that bot:

   ```bash
   echo 'MyBot=http://127.0.0.1:8800/hooks/wh_…/whsec_…' >> ~/omb-webreports/jobs/.notify.env
   chmod 600 ~/omb-webreports/jobs/.notify.env
   ```

   One line per bot; `*=<url>` is a fallback for all bots. OpenMausBot's webhook
   receiver listens on `127.0.0.1:<its port + 1>` (8800 by default).

3. Test it: `webdata-job notify-test MyBot`. The bot should get a test event.
   If OpenMausBot asks you to verify the webhook's first delivery, this is it.

Manual runs (`webdata-job run`) never notify: you see the error directly.
