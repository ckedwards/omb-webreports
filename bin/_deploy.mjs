// Publishing chosen pages to the internet, on Cloudflare: the settings and the
// copy that gets deployed. Used by bin/webdata-deploy (the service, as the
// omb-webreports-deploy user, and its status), bin/_admin-deploy.mjs
// (sudo webdata-admin deploy) and webdata-info.
//
// A page is published only after a person runs `sudo webdata-admin deploy add
// <slug>`, which records the page and the databases its report.json lists at
// that moment in DEPLOY_CONFIG (root-owned). Bots can change a published page
// and its data (those updates go out on their own), but can't publish another
// page or database. A page that starts reading another database is held: the
// internet keeps the version last published (its files can hold that
// database's rows, e.g. initial.json) until a person adds the page again.
//
// The copy holds only regular files, opened without following links and
// checked to be inside the folder they were copied from: the reports and data
// are the owner's (and so the bots') to fill, and the service can read things
// they can't (its API token).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, PLATFORM_DIR, REPORTS_DIR, PUBLISHED_DIR } from './_config.mjs';

const ETC = path.dirname(CONFIG_FILE);
/** Root-owned, readable by all: account, Worker name, password on/off, the published pages. */
export const DEPLOY_CONFIG = process.env.WEBDATA_DEPLOY_CONFIG || path.join(ETC, 'deploy.json');
/** Root-only (0600): the Cloudflare API token and the site password. The service
 *  gets it as a systemd credential (LoadCredential=deploy). */
export const DEPLOY_SECRETS = process.env.WEBDATA_DEPLOY_SECRETS || path.join(ETC, 'deploy-secrets.json');
/** The service's StateDirectory: state.json (readable by all), the staged copy and
 *  the last deployed one (published/, for held pages), both private. */
export const DEPLOY_STATE_DIR = process.env.WEBDATA_DEPLOY_STATE || '/var/lib/omb-webreports-deploy';
export const DEPLOY_STATE = path.join(DEPLOY_STATE_DIR, 'state.json');
export const PUBLISHED_COPY = path.join(DEPLOY_STATE_DIR, 'published');

export const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const DB = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
export const WORKER = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Cloudflare's limits for a Worker's static assets (Workers Free). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20_000;

export function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

/** deploy.json, normalized: { account_id, worker, password, pages: { slug: { databases, added } } }. */
export function loadConfig(file = DEPLOY_CONFIG) {
  const c = readJSON(file, {}) || {};
  const pages = {};
  for (const [slug, p] of Object.entries(c.pages || {})) {
    if (!SLUG.test(slug)) continue;
    pages[slug] = { databases: (Array.isArray(p?.databases) ? p.databases : []).filter((d) => DB.test(d)), added: p?.added || null };
  }
  return {
    account_id: /^[0-9a-f]{32}$/.test(c.account_id || '') ? c.account_id : null,
    worker: WORKER.test(c.worker || '') ? c.worker : null,
    password: c.password === true,
    pages,
  };
}

/** The databases a report's report.json lists (valid names only), or null if it has none to read. */
export function reportDatabases(reportJsonText) {
  let r;
  try { r = JSON.parse(reportJsonText); } catch { return null; }
  return Array.isArray(r?.databases) ? [...new Set(r.databases.filter((d) => typeof d === 'string' && DB.test(d)))] : [];
}

// ---------------------------------------------------------------- reading the owner's files safely

/** The open file's real path (the kernel's view), to check it is where we asked. */
const fdPath = (fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; } };

/**
 * A regular file's contents, or null: never through a symlink, never a FIFO or
 * device, and only if the file really is inside `root` (a real path).
 */
export function readInside(root, file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const real = fdPath(fd);
    if (!real || !real.startsWith(root + path.sep)) return null;
    if (st.size > MAX_FILE_BYTES) return { tooBig: st.size };
    return { data: fs.readFileSync(fd) };
  } finally { fs.closeSync(fd); }
}

/** Every non-dot regular file under dir, as paths relative to it (no symlinks followed). */
function walk(dir, rel = '', out = [], skip = () => false) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    if (e.isDirectory()) walk(dir, r, out, skip);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** A directory that is really a directory (not a link to one), as its real path; else null. */
function realDir(p) {
  try { return fs.lstatSync(p).isDirectory() ? fs.realpathSync(p) : null; } catch { return null; }
}

// ---------------------------------------------------------------- what gets published

/**
 * Where each published file comes from, without reading anything: for the
 * service's cheap change check, and the base of stage(). Returns
 * { sources: [{ to, root, from }], pages, databases, notes }.
 */
export function plan(conf, previous = PUBLISHED_COPY) {
  const sources = [];
  const notes = [];
  const add = (to, root, from) => sources.push({ to, root, from });

  // The shared site: front page, its icons and manifest, /lib. Not the design gallery.
  const platform = realDir(PLATFORM_DIR);
  if (platform) {
    for (const r of walk(platform, '', [], (r) => r === 'reports' || r === 'data')) add(r, platform, path.join(platform, r));
  }

  const reportsRoot = realDir(REPORTS_DIR);
  const dataRoot = realDir(PUBLISHED_DIR);
  const pages = [];
  const held = [];
  const databases = new Set();
  for (const [slug, p] of Object.entries(conf.pages)) {
    const dir = reportsRoot && realDir(path.join(REPORTS_DIR, slug));
    if (!dir || path.dirname(dir) !== reportsRoot) { notes.push(`${slug}: no such report (or not a plain folder); not published`); continue; }
    const now = reportDatabases(readInside(reportsRoot, path.join(dir, 'report.json'))?.data?.toString('utf8') ?? '') || [];
    for (const db of p.databases) if (now.includes(db)) databases.add(db);
    const extra = now.filter((db) => !p.databases.includes(db));
    if (!extra.length) {
      pages.push(slug);
      for (const r of walk(dir)) add(`reports/${slug}/${r}`, reportsRoot, path.join(dir, r));
      continue;
    }
    // Held: the last published version of the page, if there is one.
    const prevRoot = realDir(previous);
    const prev = prevRoot && realDir(path.join(previous, 'reports', slug));
    const approve = `sudo webdata-admin deploy add ${slug}`;
    if (prev) {
      pages.push(slug);
      held.push(slug);
      for (const r of walk(prev)) add(`reports/${slug}/${r}`, prevRoot, path.join(prev, r));
      notes.push(`${slug} now also reads ${extra.join(', ')}: the internet keeps its last published version until you approve that: ${approve}`);
    } else {
      notes.push(`${slug} now also reads ${extra.join(', ')}: not published until you approve that: ${approve}`);
    }
  }

  // Each database: <db>.duckdb (and any other <db>.<ext> file), and a <db>/ folder.
  if (dataRoot) {
    let names = [];
    try { names = fs.readdirSync(dataRoot, { withFileTypes: true }); } catch {}
    for (const db of databases) {
      for (const e of names) {
        if (e.isFile() && e.name.startsWith(`${db}.`) && !e.name.slice(db.length + 1).includes('.')) add(`data/${e.name}`, dataRoot, path.join(dataRoot, e.name));
        if (e.isDirectory() && e.name === db) for (const r of walk(path.join(dataRoot, db))) add(`data/${db}/${r}`, dataRoot, path.join(dataRoot, db, r));
      }
    }
  }
  return { sources, pages, held, databases: [...databases].sort(), notes, reportsRoot, dataRoot };
}

/** A cheap fingerprint of everything a deploy would contain (names, sizes, times). */
export function fingerprint(conf, extra = '') {
  const p = plan(conf);
  const h = crypto.createHash('sha256').update(JSON.stringify(conf)).update(extra);
  for (const s of p.sources) {
    try { const st = fs.lstatSync(s.from); h.update(`${s.to}\0${st.size}\0${st.mtimeMs}\0${st.ino}\n`); } catch { h.update(`${s.to}\0gone\n`); }
  }
  for (const f of [path.join(REPORTS_DIR, 'index.json'), path.join(PUBLISHED_DIR, 'catalog.json')]) {
    try { const st = fs.statSync(f); h.update(`${f}\0${st.size}\0${st.mtimeMs}\n`); } catch {}
  }
  return h.digest('hex');
}

const HEADERS = `# Written by webdata-deploy. Browsers revalidate everything by ETag (Cloudflare's default).
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: no-referrer
  X-Robots-Tag: noindex
`;

/**
 * Write the copy to deploy into `site` (which must not exist yet). Returns
 * { files, bytes, hash, pages, databases, notes }. The hash covers every file's
 * path and contents, so the service can tell "nothing changed" from a new deploy.
 */
export function stage(conf, site) {
  const p = plan(conf);
  const notes = [...p.notes];
  fs.mkdirSync(site, { recursive: true, mode: 0o700 });
  const files = new Map();
  for (const s of p.sources) {
    const r = readInside(s.root, s.from);
    if (!r) { notes.push(`${s.to}: skipped (not a plain file, or it moved)`); continue; }
    if (r.tooBig) { notes.push(`${s.to}: skipped, ${(r.tooBig / 1048576).toFixed(1)} MB (Cloudflare's limit is 25 MB a file)`); continue; }
    files.set(s.to, r.data);
  }

  // The front page's lists, cut down to what's published.
  const pages = new Set(p.pages);
  const index = p.reportsRoot && readJSON0(readInside(p.reportsRoot, path.join(p.reportsRoot, 'index.json')));
  const reports = (Array.isArray(index?.reports) ? index.reports : []).filter((r) => pages.has(r?.slug));
  files.set('reports/index.json', Buffer.from(JSON.stringify({ ...index, reports }, null, 2) + '\n'));
  const dbs = new Set(p.databases);
  const catalog = p.dataRoot && readJSON0(readInside(p.dataRoot, path.join(p.dataRoot, 'catalog.json')));
  const databases = (Array.isArray(catalog?.databases) ? catalog.databases : []).filter((d) => dbs.has(d?.name));
  files.set('data/catalog.json', Buffer.from(JSON.stringify({ ...catalog, databases }, null, 2) + '\n'));
  files.set('_headers', Buffer.from(HEADERS));

  if (files.size > MAX_FILES) throw new Error(`${files.size} files: Cloudflare's limit is ${MAX_FILES}`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const to of [...files.keys()].sort()) {
    const data = files.get(to);
    const dest = path.join(site, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    hash.update(`${to}\0${crypto.createHash('sha256').update(data).digest('hex')}\n`);
    bytes += data.length;
  }
  return { files: files.size, bytes, hash: hash.digest('hex'), pages: p.pages, held: p.held, databases: p.databases, notes };
}

function readJSON0(r) { try { return r?.data ? JSON.parse(r.data.toString('utf8')) : null; } catch { return null; } }
