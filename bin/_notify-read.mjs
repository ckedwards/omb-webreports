#!/usr/bin/env node
// Run by webdata-notify, as the owner (never as root): reads the jobs' job.json,
// status.json, test requests and failure log tails, and prints them as one
// JSON document. These files are the owner's, and so the bots', to write.
// Reading them as the owner means a planted symlink can only reach what the
// owner could read anyway; root then treats the output as untrusted data.

import fs from 'node:fs';
import path from 'node:path';

import { JOBS_DIR, STATE_DIR } from './_config.mjs';

const JOBS = process.env.WEBDATA_JOBS_DIR || JOBS_DIR;
const STATE = process.env.WEBDATA_JOBS_STATE || path.join(STATE_DIR, 'jobs');
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_JSON = 64 * 1024;
const MAX_JOBS = 200;
const TAIL = 16 * 1024;

/** A regular file's text, or null (missing, not a file, too big). */
function read(file, max = MAX_JSON) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
const json = (file) => { try { const t = read(file); return t == null ? null : JSON.parse(t); } catch { return null; } };

/** The last TAIL bytes of a run log under the job's own runs/ folder. */
function tail(name, rel) {
  const inRuns = path.join(STATE, name, 'runs', path.basename(String(rel ?? '')));
  try {
    const st = fs.statSync(inRuns);
    if (!st.isFile()) return '';
    const fd = fs.openSync(inRuns, 'r');
    try {
      const len = Math.min(st.size, TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

let names = [];
try { names = fs.readdirSync(JOBS, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort().slice(0, MAX_JOBS); } catch {}
const jobs = names.map((name) => {
  const status = json(path.join(STATE, name, 'status.json'));
  return {
    name,
    job: json(path.join(JOBS, name, 'job.json')),
    status,
    log_tail: status && status.last_ok === false ? tail(name, status.last_log) : '',
    test_request: (read(path.join(STATE, name, 'notify-test'), 100) ?? '').trim() || null,
  };
});
process.stdout.write(JSON.stringify({ jobs }));
