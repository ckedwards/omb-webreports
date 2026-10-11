// Shared by webdata-sync and webdata-bake: which reports get a baked first
// render (initial.json), and when it is out of date. Cheap: stats only.

import fs from 'node:fs';
import path from 'node:path';

import { PLATFORM_DIR, PUBLISHED_DIR, REPORTS_DIR, STATE_DIR, SYNC_JSON } from './_config.mjs';

const REPORTS = REPORTS_DIR;
export const BAKE_STATE = path.join(STATE_DIR, 'bake.json');
export const BAKE_FILE = 'initial.json';
const QUIET_MS = 5_000;        // inputs unchanged this long before baking (bots write in bursts)
const RETRY_MS = 10 * 60_000;  // retry a failed bake with unchanged inputs after this

const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

/** sync.json settings for baking. */
export function bakeConfig() {
  const c = readJSON(SYNC_JSON, {});
  return { enabled: c.bake !== false, maxBytes: (Number(c.bake_max_kb) || 1024) * 1024 };
}

/** Reports that can be baked: they use a database and import kit through the
 *  managed modules block (where the sync links initial.json). */
export function bakeTargets() {
  let dirs = [];
  try { dirs = fs.readdirSync(REPORTS, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of dirs) {
    if (!e.isDirectory() || /^[._]/.test(e.name)) continue;
    const dir = path.join(REPORTS, e.name);
    const meta = readJSON(path.join(dir, 'report.json'), null);
    const dbs = Array.isArray(meta?.databases) ? meta.databases.filter((d) => typeof d === 'string') : [];
    if (!dbs.length) continue;
    let html;
    try { html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8'); } catch { continue; }
    if (!html.includes('<!-- webdata:modules') || !/from ['"]\/lib\/kit\.js['"]/.test(html)) continue;
    const inputs = [path.join(dir, 'index.html'), path.join(dir, 'report.json'), path.join(PLATFORM_DIR, 'lib', 'kit.js'),
      ...dbs.map((d) => path.join(PUBLISHED_DIR, `${d}.duckdb`))];
    let newest = 0;
    const sig = inputs.map((f) => {
      try { const s = fs.statSync(f); newest = Math.max(newest, s.mtimeMs); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; }
    }).join('|');
    out.push({ slug: e.name, dir, key: sig, newest });
  }
  return out;
}

export const readBakeState = () => readJSON(BAKE_STATE, {});

/** Targets whose bake is missing or out of date and whose inputs have settled. */
export function dueTargets(state = readBakeState(), now = Date.now()) {
  return bakeTargets().filter((t) => {
    if (now - t.newest < QUIET_MS) return false;
    const s = state[t.slug];
    if (!s || s.key !== t.key) return true;
    return !!s.failed_at && now - s.failed_at > RETRY_MS;
  });
}
