// Shared settings for the node tools in bin/: the checkout root plus
// config.env (see config.example.env), with the same defaults install.sh uses.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no config.env: defaults only */ }
  return env;
}

const file = readEnv(path.join(ROOT, 'config.env'));
const pick = (key, fallback) => process.env[key] || file[key] || fallback;

function tailscaleIp() {
  try { return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
  catch { return ''; }
}

const port = pick('LISTEN_PORT', '8080');
export const LISTEN_IP = pick('LISTEN_IP', '') || tailscaleIp() || '127.0.0.1';
export const SITE_URL = pick('SITE_URL', `http://${LISTEN_IP}:${port}`).replace(/\/$/, '');
/** Apache directly (no HTTPS proxy): for tools on this machine. */
export const LOCAL_URL = `http://${LISTEN_IP.includes(':') ? `[${LISTEN_IP}]` : LISTEN_IP}:${port}`;
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
