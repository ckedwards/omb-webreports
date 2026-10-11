// Shared by webdata-skills (and the admin scripts through it): the repo's
// agent skills, the OpenMausBot package built from them, and a small client
// for OpenMausBot's API on this machine.
//
// The package (skills/omb-webreports.openmaus.json) carries the four skills
// and one preset bot, "Report builder", for OpenMausBot's New bot dialog. It
// is generated from skills/*/SKILL.md, never edited by hand, and validated
// with OpenMausBot's own package parser.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, NODE_MODULES_DIR, OMB_URL } from './_config.mjs';

export const SKILLS_DIR = path.join(ROOT, 'skills');
export const PACKAGE_FILE = path.join(SKILLS_DIR, 'omb-webreports.openmaus.json');
export const PACKAGE_ID = 'omb-webreports';
const REPO_URL = 'https://github.com/ckedwards/omb-webreports';

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- the repo's skills

/** [{ name, description, text, sha256 }] from skills/<name>/SKILL.md. */
export function repoSkills() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
    .map((e) => {
      const text = fs.readFileSync(path.join(SKILLS_DIR, e.name, 'SKILL.md'), 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (field('name') !== e.name) throw new Error(`skills/${e.name}/SKILL.md: frontmatter name must be "${e.name}"`);
      return { name: e.name, description: field('description') ?? '', text, sha256: sha256(text) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Where a skill came from, recorded in the bot's skill list. */
export const skillSource = (name) => `${REPO_URL}/blob/main/skills/${name}/SKILL.md`;

// ---------------------------------------------------------------- the package

// Standing instructions for bots made from the preset. No machine paths: the
// bot learns ROOT and SITE from webdata-info, like the skills do.
const SOUL = `You build and maintain reports on this machine's omb-webreports site: live, phone-first web pages that read your DuckDB data in the browser and can be saved to an iPhone home screen.

Before any report work, run \`webdata-info\`. It prints ROOT (where omb-webreports is installed), SITE (the address people open) and the documents to read; the webdata-* commands are on PATH.

Use your webdata skills for the work:
- webdata-reports-read: what reports and data exist, links, numbers from published data.
- webdata-report-create: a new analysis report (tiles, charts, tables) or a briefing (news, weather, scores).
- webdata-report-update: change an existing report.
- webdata-data-job: keep collected data fresh with a scheduled script (no AI at run time).

Keep the data you collect in your own database's main schema, with clear column names and real types. Check every page with webdata-check before you share it, and share links using SITE. Never edit ROOT/webroot/lib, ROOT/admin or generated files. Ask before deleting a report or changing a job's schedule.`;

function packageBody(skills) {
  return {
    id: PACKAGE_ID,
    name: 'omb-webreports',
    tagline: 'Bots that build live, phone-first data reports from their DuckDB data',
    summary: 'Skills and a preset bot for the omb-webreports site: create and update reports and briefings, read published data, and schedule deterministic data refreshes. Requires omb-webreports installed on the same machine (see its README).',
    category: 'Data and reporting',
    author: { name: 'ckedwards', url: REPO_URL },
    license: 'MIT',
    tags: ['reports', 'duckdb', 'dashboards', 'data'],
    outcomes: [
      'Ask for a report and get a link to a live page that works on a phone',
      'Keep collected data fresh with scheduled scripts',
      'Briefing pages: news, weather and scores from several sources',
    ],
    setupMinutes: 5,
    requirements: { apps: [], capabilities: ['shell', 'files'] },
    skills: {
      version: 1,
      entries: skills.map((s) => ({ name: s.name, description: s.description, source: skillSource(s.name), instructions: s.text })),
    },
    presets: [{
      key: 'report-builder',
      name: 'Report builder',
      description: 'Builds and maintains reports and briefings on the omb-webreports site, and schedules their data refreshes.',
      bot: {
        name: 'Reports',
        title: 'Builds and maintains live reports',
        description: 'Turns collected data into live reports and briefings on the omb-webreports site, and keeps their data fresh.',
        soul: SOUL,
        appearance: { color: 'blue' },
      },
      skills: skills.map((s) => s.name),
    }],
  };
}

/** The package document. The release only changes when the content does:
 *  unchanged content keeps the previous file's release (re-importing it is a
 *  no-op in OpenMausBot), changed content gets YYYY.MMDD.N for today. */
export function buildPackage(skills = repoSkills(), previous = readPackageFile()) {
  const body = packageBody(skills);
  const fingerprint = sha256(JSON.stringify(body)).slice(0, 16);
  const prevFingerprint = /fingerprint ([0-9a-f]{16})/.exec(previous?.package?.notes ?? '')?.[1];
  let release;
  if (previous && prevFingerprint === fingerprint) release = previous.package.release;
  else {
    const d = new Date();
    const day = `${d.getUTCFullYear()}.${(d.getUTCMonth() + 1) * 100 + d.getUTCDate()}`;
    const prev = previous?.package?.release ?? '';
    const n = prev.startsWith(`${day}.`) ? Number(prev.split('.')[2]) + 1 : 0;
    release = `${day}.${n}`;
  }
  return {
    format: 'openmaus.package',
    version: 2,
    package: { ...body, release, notes: `Generated from skills/*/SKILL.md by webdata-skills package (content fingerprint ${fingerprint}).` },
  };
}

export function readPackageFile() {
  try { return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')); } catch { return null; }
}

/** Check every skill with OpenMausBot's own SKILL.md parser and safety scan.
 *  (Its package parser isn't loadable outside its bundled server; the whole
 *  package is validated by OpenMausBot when it's imported, which sync does.)
 *  Returns scan findings; throws on a skill OpenMausBot would refuse. */
export async function checkSkills(skills = repoSkills()) {
  const md = await import(pathToFileURL(path.join(NODE_MODULES_DIR, 'openmausbot', 'dist-server', 'shared', 'skill-md.js')).href);
  const findings = [];
  for (const s of skills) {
    const parsed = md.parseSkillMd(s.text);
    if ('error' in parsed) throw new Error(`skills/${s.name}/SKILL.md: ${parsed.error}`);
    for (const f of md.scanSkillText(s.text)) findings.push(`${s.name}: ${typeof f === 'string' ? f : JSON.stringify(f)}`);
  }
  return findings;
}

// ---------------------------------------------------------------- OpenMausBot API
//
// Two ways to be allowed in:
//   - OpenMausBot's default on a self-hosted server ("owner" loopback trust):
//     any request from this machine acts as the owner. No credential.
//   - Isolated (OMB_LOOPBACK_TRUST=service in config.env, applied by
//     admin/install.sh): local requests without a login can't administer
//     OpenMausBot, which keeps bots' shells from doing it. webdata-skills then
//     uses its own full-access session, stored where only root can read it
//     (bots run as the owner and can't), so these commands run with sudo.

export const SESSION_FILE = process.env.WEBDATA_OMB_SESSION || '/etc/omb-webreports/omb-session.json';
export const SESSION_LABEL = 'omb-webreports (webdata-skills)';

export class OmbError extends Error {}

/** The saved session, null if there is none; throws if it exists but we can't read it. */
export function readSession() {
  let text;
  try { text = fs.readFileSync(SESSION_FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'EACCES') throw new OmbError(`OpenMausBot is isolated and this needs its session (${SESSION_FILE}, root only): run it with sudo`);
    throw e;
  }
  return JSON.parse(text);
}

export function saveSession(session) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o755 });
  const tmp = `${SESSION_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, SESSION_FILE);
}

/** The saved session's token, or undefined (none, or not readable by this user). */
function sessionToken() {
  try { return readSession()?.token; } catch (e) { if (e instanceof OmbError) return undefined; throw e; }
}
const sessionUnreadable = () => { try { readSession(); return false; } catch { return true; } };

/** JSON request to OpenMausBot on this machine, with the saved session if there is one. */
export async function omb(method, apiPath, body, { token = sessionToken(), auth = true } = {}) {
  let r;
  try {
    r = await fetch(`${OMB_URL}${apiPath}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new OmbError(`OpenMausBot isn't reachable at ${OMB_URL} (${e.cause?.code || e.message}); is the openmausbot service running?`);
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) {
    const err = new OmbError(`OpenMausBot refused ${method} ${apiPath} (${r.status}): ${data?.error ?? 'not allowed'}. ` +
      (token ? 'The saved session has expired or was revoked: sudo webdata-skills login'
        : sessionUnreadable() ? `OpenMausBot is isolated; this needs its session (${SESSION_FILE}, root only): run it with sudo`
        : 'OpenMausBot is isolated (OMB_LOOPBACK_TRUST=service) and there is no saved session: sudo webdata-skills login'));
    err.status = r.status;
    throw err;
  }
  if (!r.ok) throw new OmbError(`${method} ${apiPath}: ${r.status} ${data?.error ?? text.slice(0, 200)}`);
  return data;
}

/** Wait until OpenMausBot answers (it may be restarting). */
export async function ombReady(timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { await omb('GET', '/api/health'); return; } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
