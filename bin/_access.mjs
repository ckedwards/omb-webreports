// Password access, shared by webdata-gate (the site's front door) and
// webdata-access (how bots set it).
//
// The unit of access is a published database (its name in DATA, e.g.
// cary-news): its .duckdb file, its other files (DATA/<name>.*, DATA/<name>/…)
// and every report whose report.json lists it. Each one is public or private:
//
//   ACCESS_DIR/<name>.json   {"access": "public" | "private",
//                             "password": {scrypt hash} (private only), "changed_at": …}
//
// A database with no file follows ACCESS_DEFAULT (config.env, root-owned).
// A file that exists but can't be read is treated as private with no
// password: a broken setting fails closed, never open. A report that lists no
// databases follows ACCESS_DEFAULT.
//
// A visitor who enters the right password gets a cookie for that database,
// signed by the gate's key (which bots can't read) over the password's salt:
// setting a new password gives a new salt, so every old cookie stops working.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ACCESS_DIR, ACCESS_DEFAULT, REPORTS_DIR, GATE_PORT, GATE_SOCKET, SITE_TS_SOCKET } from './_config.mjs';

/** Database names as published (lowercased bot names). */
export const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MIN_PASSWORD = 12;
const MAX_FILE = 16 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
export const COOKIE_DAYS = 365;

// ---------------------------------------------------------------- reading (cached by mtime)

const cache = new Map();
/** parse(JSON) of a small file; null if it doesn't exist; BROKEN if it exists but can't be used. */
const BROKEN = Symbol('broken');
function cachedJSON(file, parse) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return hit.value;
  let value = BROKEN;
  try { if (st.isFile() && st.size <= MAX_FILE) value = parse(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? BROKEN; } catch { value = BROKEN; }
  cache.set(file, { mtime: st.mtimeMs, size: st.size, ino: st.ino, value });
  return value;
}

const b64 = (s) => { try { return Buffer.from(String(s), 'base64'); } catch { return Buffer.alloc(0); } };
function parsePassword(p) {
  if (!p || p.alg !== 'scrypt') return null;
  const N = Number(p.N), r = Number(p.r), par = Number(p.p);
  const salt = b64(p.salt), hash = b64(p.hash);
  if (!(N >= 1 << 14 && N <= 1 << 20 && (N & (N - 1)) === 0 && r === 8 && par >= 1 && par <= 4)) return null;
  if (salt.length !== 16 || hash.length !== 32) return null;
  return { N, r, p: par, salt, hash };
}
function parseSetting(raw) {
  if (raw?.access !== 'public' && raw?.access !== 'private') return null;
  return {
    access: raw.access,
    password: raw.access === 'private' ? parsePassword(raw.password) : null,
    changed_at: typeof raw.changed_at === 'string' ? raw.changed_at.slice(0, 40) : null,
    explicit: true,
  };
}

/** A database's access: { access, password, changed_at, explicit, broken? }. */
export function accessOf(name) {
  if (!NAME.test(name)) return { access: 'private', password: null, explicit: false, broken: true };
  const v = cachedJSON(path.join(ACCESS_DIR, `${name}.json`), parseSetting);
  if (v === BROKEN) return { access: 'private', password: null, explicit: true, broken: true };
  return v ?? { access: ACCESS_DEFAULT, password: null, changed_at: null, explicit: false };
}

/** The databases a report reads (its report.json), or null if there is no such report. */
export function reportDatabases(slug) {
  if (!/^[_a-z0-9][a-z0-9_-]{0,80}$/.test(slug)) return null;
  const dir = path.join(REPORTS_DIR, slug);
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  const v = cachedJSON(path.join(dir, 'report.json'), (raw) => ({
    databases: [...new Set((Array.isArray(raw?.databases) ? raw.databases : []).map(String))],
  }));
  if (v === BROKEN || v === null) return { databases: [] };
  return v;
}

// ---------------------------------------------------------------- writing (webdata-access, as the owner)

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
  return { alg: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function writeSetting(name, setting) {
  if (!NAME.test(name)) throw new Error(`"${name}" isn't a database name (lowercase letters, digits, - and _)`);
  fs.mkdirSync(ACCESS_DIR, { recursive: true, mode: 0o750 });
  const file = path.join(ACCESS_DIR, `${name}.json`);
  const tmp = path.join(ACCESS_DIR, `.${name}.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(setting, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, file);
}

export function removeSetting(name) {
  if (!NAME.test(name)) throw new Error(`"${name}" isn't a database name`);
  fs.rmSync(path.join(ACCESS_DIR, `${name}.json`), { force: true });
}

// ---------------------------------------------------------------- checking (webdata-gate)

export function verifyPassword(pw, password) {
  return new Promise((resolve) => {
    crypto.scrypt(String(pw), password.salt, password.hash.length,
      { N: password.N, r: password.r, p: password.p, maxmem: SCRYPT_MAXMEM }, (err, got) => {
        resolve(!err && crypto.timingSafeEqual(got, password.hash));
      });
  });
}

export const cookieName = (name) => `omb_${name}`;
const sign = (key, name, password, exp) =>
  crypto.createHmac('sha256', key).update(`${name}\n${password.salt.toString('base64')}\n${exp}`).digest('base64url');

/** A cookie value for this database's current password, valid for COOKIE_DAYS. */
export function makeToken(key, name, password, now = Date.now()) {
  const exp = Math.floor(now / 1000) + COOKIE_DAYS * 86400;
  return `${exp}.${sign(key, name, password, exp)}`;
}

export function tokenValid(key, name, password, value, now = Date.now()) {
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ''));
  if (!m || Number(m[1]) * 1000 < now) return false;
  const want = Buffer.from(sign(key, name, password, Number(m[1])));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------------------------------------------------------------- who can reach the site

/** The serve config of the machine's tailscaled, or of the one at `socket`; null if it can't be read. */
function serveStatus(socket) {
  try {
    return JSON.parse(execFileSync('tailscale', [...(socket ? [`--socket=${socket}`] : []), 'serve', 'status', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
  } catch { return null; }
}

/**
 * Who can reach the gate, from the machine's tailscale serve and the site's own
 * node (SITE_TS_SOCKET): 'internet' if Funnel sends the public there, 'tailnet'
 * if only tailscale serve does, else 'unknown'. hosts: [{ host, funnel }].
 */
export function reach() {
  const target = new RegExp(`^(http://(127\\.0\\.0\\.1|localhost):${GATE_PORT}/?|unix:${GATE_SOCKET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`);
  const hosts = [];
  let asked = false;
  for (const st of [serveStatus(null), fs.existsSync(SITE_TS_SOCKET) ? serveStatus(SITE_TS_SOCKET) : null]) {
    if (!st) continue;
    asked = true;
    for (const [host, w] of Object.entries(st?.Web ?? {})) {
      if (Object.values(w?.Handlers ?? {}).some((h) => target.test(h?.Proxy ?? ''))) hosts.push({ host, funnel: st?.AllowFunnel?.[host] === true });
    }
  }
  return { reach: hosts.some((h) => h.funnel) ? 'internet' : hosts.length ? 'tailnet' : 'unknown', hosts, asked };
}
