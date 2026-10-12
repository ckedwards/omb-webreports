// Failure alerts, shared by webdata-job (the owner's runner) and webdata-notify
// (the root service that owns the webhooks and sends the alerts).
//
// A job asks for alerts in its job.json:
//   "notify_failure": "<bot>"        the bot that gets a task when the job fails
//   "notify_after": "12h"            a *temporary* failure (exit 75) alerts only after this long
//   "assume_gone_after": "3d"        temporary this long: alert as "the source may be gone"
//   "sources": ["https://…"]         optional; hosts to check on failure (default: URLs in the script)
//
// The runner records what kind of failure each run was (exit 75 = temporary:
// the source couldn't be reached; anything else = broken) and, after a failed
// scheduled run, whether this machine could reach the internet and the
// sources. webdata-notify reads that (as data, never trusting it for anything
// but the alert itself) and decides with decide() below.

import path from 'node:path';

/** The service's folder (root-owned). status.json there is readable by everyone and
 *  holds no secrets; private/ (0700) holds the webhook secrets and alert state. */
export const NOTIFY_DIR = process.env.WEBDATA_NOTIFY_DIR || '/var/lib/omb-webreports-notify';
export const NOTIFY_STATUS = path.join(NOTIFY_DIR, 'status.json');
/** webdata-notify updates status.json at least this often while it runs. */
export const HEARTBEAT_MS = 60_000;

/** EX_TEMPFAIL: a job script exits with this when its source can't be reached. */
export const TEMPFAIL = 75;
export const DEFAULT_NOTIFY_AFTER = 12 * 3600_000;
export const DEFAULT_GONE_AFTER = 3 * 86400_000;
/** Broken runs in a row before an alert: one can be a fluke. */
export const BROKEN_AFTER = 2;
/** While a job keeps failing: a reminder at most this often (a worse stage alerts at once). */
export const REMIND_MS = 24 * 3600_000;

const UNITS = { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 };

/** "30m", "12h", "3d", "1w" → milliseconds. */
export function parseDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mhdw])\s*$/i.exec(String(text ?? ''));
  if (!m) throw new Error(`"${text}" is not a duration like 30m, 12h, 3d or 1w`);
  const ms = Number(m[1]) * UNITS[m[2].toLowerCase()];
  if (!(ms >= 60_000 && ms <= 90 * 86400_000)) throw new Error(`"${text}" must be between 1m and 90d`);
  return ms;
}

/** 50 400 000 → "14h"; 266 400 000 → "3d 2h". */
export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const BOT_NAME = /^[^\u0000-\u001f]{1,100}$/;

/** The alert settings in a parsed job.json: { notify, notifyAfter, assumeGoneAfter, sources, problems }. */
export function alertSettings(raw) {
  const problems = [];
  let notify = null;
  if (raw?.notify_failure != null) {
    if (typeof raw.notify_failure === 'string' && BOT_NAME.test(raw.notify_failure.trim())) notify = raw.notify_failure.trim();
    else problems.push('notify_failure must be a bot name');
  }
  const duration = (key, fallback) => {
    if (raw?.[key] == null) return fallback;
    try { return parseDuration(raw[key]); } catch (e) { problems.push(`${key}: ${e.message}`); return fallback; }
  };
  const notifyAfter = duration('notify_after', DEFAULT_NOTIFY_AFTER);
  const assumeGoneAfter = duration('assume_gone_after', DEFAULT_GONE_AFTER);
  if (assumeGoneAfter < notifyAfter) problems.push('assume_gone_after must be at least notify_after');
  let sources = [];
  if (raw?.sources != null) {
    if (Array.isArray(raw.sources) && raw.sources.length <= 10 && raw.sources.every((s) => typeof s === 'string' && s.length <= 300)) sources = raw.sources;
    else problems.push('sources must be a list of up to 10 URLs');
  }
  return { notify, notifyAfter, assumeGoneAfter, sources, problems };
}

const RANK = { outage: 1, broken: 2, possibly_gone: 3 };
export const STAGE_TEXT = {
  outage: 'temporary failure (the source could not be reached) lasting longer than expected',
  broken: 'broken: failed twice in a row for a reason other than reaching the source',
  possibly_gone: 'temporary failure lasting so long that the source may have been shut down or moved',
};

/**
 * Should a job's failure be alerted now?
 *   status   the runner's status.json for the job
 *   settings alertSettings() of its job.json
 *   others   [{ failing, recent }] for the other enabled jobs (recent: ran in the last 2h)
 *   memory   what the service remembers for this job: { streak, stage, last_alert_at }
 * Returns { state: 'ok'|'failing'|'held'|'alerting', detail, stage?, send }.
 */
export function decide(status, settings, others, memory, now = Date.now()) {
  if (!status || status.last_ok !== false || !status.failing_since) return { state: 'ok', detail: '', send: false };
  const since = Date.parse(status.failing_since);
  const failingFor = Number.isFinite(since) ? now - since : 0;
  const kind = status.failure_kind === 'temporary' ? 'temporary' : 'broken';
  const what = `${kind} failure for ${fmtDuration(failingFor)}`;
  if (status.last_trigger !== 'schedule') {
    return { state: 'failing', detail: `${what}; the last run was manual, so alerts wait for the next scheduled run`, send: false };
  }
  if (status.checks?.internet === 'down') {
    return { state: 'held', detail: `${what}; held: this machine couldn't reach the internet at the last failure`, send: false };
  }
  const recent = others.filter((o) => o.recent);
  if (kind === 'temporary' && recent.length >= 2 && recent.filter((o) => o.failing).length / recent.length >= 0.75) {
    return { state: 'held', detail: `${what}; held: most other jobs are failing too, so it is likely this machine's connection`, send: false };
  }
  let stage;
  if (kind === 'temporary') {
    if (failingFor < settings.notifyAfter) return { state: 'failing', detail: `${what}; alert after ${fmtDuration(settings.notifyAfter)}`, send: false };
    stage = failingFor >= settings.assumeGoneAfter ? 'possibly_gone' : 'outage';
  } else {
    if ((status.broken_failures || 0) < BROKEN_AFTER) return { state: 'failing', detail: `${what}; alert if the next scheduled run fails too`, send: false };
    stage = 'broken';
  }
  const same = memory?.streak === status.failing_since;
  const lastAlert = same && memory.last_alert_at ? Date.parse(memory.last_alert_at) : NaN;
  const send = !Number.isFinite(lastAlert) || RANK[stage] > (RANK[memory.stage] || 0) || now - lastAlert >= REMIND_MS;
  return { state: 'alerting', stage, detail: `${what}; ${STAGE_TEXT[stage]}`, send };
}
