// Shared settings for the node tools in bin/. Four places matter:
//
//   ROOT          this copy of the code: the installed one (/usr/local/lib/
//                 omb-webreports, root-owned) or a development checkout when a
//                 tool is run from one
//   CONFIG_FILE   /etc/omb-webreports/config.env, written by admin/install.sh
//                 (root-owned: nothing a bot can write decides where things go)
//   PLATFORM_DIR  the site's shared files as served: front page, lib/, gallery
//                 (root-owned, part of the installed copy)
//   DATA_DIR      your content: reports, published data, jobs, state (owned by
//                 WEBREPORTS_OWNER, the user OpenMausBot and its bots run as)
//
// Requests from people reach webdata-gate (GATE_PORT), which applies password
// access and passes allowed ones to Apache; Apache itself listens only on
// 127.0.0.1 (LOCAL_URL, which the tools on this machine use directly).
//
// Run directly (node _config.mjs) it prints the paths as KEY=value lines for
// the shell tools.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = process.env.OMB_WEBREPORTS_CONFIG || '/etc/omb-webreports/config.env';

function readEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* not installed yet: defaults only */ }
  return env;
}

const file = readEnv(CONFIG_FILE);
const pick = (key, fallback) => process.env[key] || file[key] || fallback;

export const INSTALLED = Boolean(file.DATA_DIR);
export const OWNER = pick('WEBREPORTS_OWNER', os.userInfo().username);
export const DATA_DIR = pick('DATA_DIR', '/var/lib/omb-webreports');
export const PLATFORM_DIR = pick('PLATFORM_DIR', path.join(ROOT, 'webroot'));
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');
export const PUBLISHED_DIR = path.join(DATA_DIR, 'data');
export const JOBS_DIR = path.join(DATA_DIR, 'jobs');
export const STATE_DIR = path.join(DATA_DIR, '.state');
export const SYNC_JSON = path.join(DATA_DIR, 'sync.json');

const port = pick('LISTEN_PORT', '8080');
/** Apache: this machine only (admin/install.sh binds it to 127.0.0.1). */
export const LISTEN_IP = pick('LISTEN_IP', '127.0.0.1');
export const GATE_PORT = pick('GATE_PORT', '8081');
/** webdata-gate, where tailscale serve (and Funnel) send people. */
export const GATE_URL = `http://127.0.0.1:${GATE_PORT}`;
export const SITE_URL = pick('SITE_URL', GATE_URL).replace(/\/$/, '');
/** Apache directly, past the gate: for tools on this machine (they see private reports too). */
export const LOCAL_URL = `http://${LISTEN_IP.includes(':') ? `[${LISTEN_IP}]` : LISTEN_IP}:${port}`;
/** Databases (and the reports that read them) with no access setting: public or private. */
export const ACCESS_DEFAULT = pick('ACCESS_DEFAULT', 'public') === 'private' ? 'private' : 'public';
/** Bots' access settings, one <database>.json each (webdata-access); read by webdata-gate. */
export const ACCESS_DIR = path.join(DATA_DIR, 'access');
export const OMB_DATA_DIR = pick('OMB_DATA_DIR', path.join(os.homedir(), '.openmausbot'));
export const NODE_MODULES_DIR = pick('NODE_MODULES_DIR', '/usr/lib/node_modules');
/** The DuckDB-WASM build reports load in the browser. It must contain the same
 *  DuckDB engine as OpenMausBot's @duckdb/node-api; admin/openmausbot-upgrade.sh
 *  finds that build and sets it in config.env. The default matches the
 *  OpenMausBot release this repo is tested with (node-api 1.5.6-r.1 = DuckDB v1.5.6). */
export const DUCKDB_WASM_VERSION = pick('DUCKDB_WASM_VERSION', '1.33.1-dev65.0');
export const ACCESS_LOG = '/var/log/apache2/webdata-access.log';
/** OpenMausBot's API on this machine (webdata-skills uses it to update bots' skills). */
export const OMB_URL = pick('OMB_URL', 'http://127.0.0.1:8799').replace(/\/$/, '');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = { ROOT, CONFIG_FILE, DATA_DIR, PLATFORM_DIR, REPORTS_DIR, PUBLISHED_DIR, JOBS_DIR, STATE_DIR, SITE_URL, LOCAL_URL, OWNER };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}
