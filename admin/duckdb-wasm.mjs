#!/usr/bin/env node
// duckdb-wasm.mjs: keep the browser's DuckDB (DuckDB-WASM, loaded by kit.js) on
// the same engine version as OpenMausBot's (@duckdb/node-api). Used by
// admin/openmausbot-upgrade.sh and webdata-info; no dependencies, Node 20+.
//
//   node admin/duckdb-wasm.mjs engine <duckdb-wasm version>  engine inside a build ("v1.5.6")
//   node admin/duckdb-wasm.mjs match <node-api version>      the DuckDB-WASM build with that engine
//   node admin/duckdb-wasm.mjs omb-match [<omb version>]     newest OpenMausBot release (up to that
//                                                            version) that has a matching build
//   node admin/duckdb-wasm.mjs cached <duckdb-wasm version>  engine from the cache only (no download)
//
// Output is key=value lines. Exit status: 0 found, 3 no match, 2 couldn't check.
//
// DuckDB-WASM's version numbers are its own (1.33.1-dev65.0 contains DuckDB
// v1.5.6) and its package metadata doesn't say which engine it contains. So
// this downloads the build's duckdb-mvp.wasm from jsDelivr (~8 MB), loads it
// with stand-in imports, and calls DuckDB's own duckdb_library_version().
// Results are cached (published builds never change): /var/cache/omb-webreports
// as root, else ~/.cache/omb-webreports.
//
// Matching: node-api "1.5.6-r.1" is engine v1.5.6. Among DuckDB-WASM builds
// with that engine, a stable release wins over a pre-release, then the newest.
// The search assumes engines don't go down as DuckDB-WASM versions go up; if
// that ever fails the result is a missed match, never a wrong one, because the
// chosen build's engine is always read directly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WASM_PKG = '@duckdb/duckdb-wasm';
const OMB_PKG = 'openmausbot';
const OMB_REPO = 'milind-soni/OpenMausBot';
const OLDEST_WASM = '1.29.0';      // older builds predate anything OpenMausBot pins
const OMB_LOOKBACK = 40;           // releases to search for omb-match
// As root (the admin scripts) the cache is /var/cache/omb-webreports, readable by
// everyone (webdata-info) and writable only by root; otherwise the user's own.
export const SYSTEM_CACHE = '/var/cache/omb-webreports/duckdb-versions.json';
const CACHE = process.getuid?.() === 0 ? SYSTEM_CACHE
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'omb-webreports', 'duckdb-versions.json');

class NoMatch extends Error {}

// ---------------------------------------------------------------- versions

const splitVer = (v) => {
  const i = v.indexOf('-');
  return { main: (i < 0 ? v : v.slice(0, i)).split('.').map(Number), pre: i < 0 ? '' : v.slice(i + 1) };
};
/** Semver order; pre-release parts compared naturally (dev9 < dev11). */
function cmp(a, b) {
  const x = splitVer(a), y = splitVer(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] || 0) !== (y.main[i] || 0)) return (x.main[i] || 0) - (y.main[i] || 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}
const cmpEngine = (a, b) => cmp(a.replace(/^v/, ''), b.replace(/^v/, ''));
const isStable = (v) => !v.includes('-');
/** @duckdb/node-api "1.5.6-r.1" -> "v1.5.6" */
const nodeApiEngine = (v) => `v${splitVer(v).main.join('.')}`;

// ---------------------------------------------------------------- cache + network

let cache;
function loadCache() {
  if (!cache) {
    try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = {}; }
    cache.wasm ??= {};      // duckdb-wasm version -> engine
    cache.omb ??= {};       // openmausbot version -> @duckdb/node-api pin ('' = none)
  }
  return cache;
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');
  } catch { /* a cache we can't write only costs downloads */ }
}

async function get(url, { accept, timeout = 120_000 } = {}) {
  const r = await fetch(url, { headers: accept ? { accept } : {}, signal: AbortSignal.timeout(timeout) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

async function registryVersions(pkg) {
  const r = await get(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`,
    { accept: 'application/vnd.npm.install-v1+json', timeout: 30_000 });
  if (!r) throw new Error(`${pkg}: not on npm`);
  return Object.keys((await r.json()).versions);
}

// ---------------------------------------------------------------- engine inside a build

/** Instantiate a DuckDB-WASM binary with stand-in imports and ask it. Nothing
 *  else in it runs: duckdb_library_version() only returns a static string. */
function engineFromWasm(bytes) {
  const mod = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536 });
  const MEM_BASE = 1 << 20;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    const ns = (imports[imp.module] ??= {});
    if (imp.kind === 'function') ns[imp.name] = () => 0;
    else if (imp.kind === 'memory') ns[imp.name] = memory;
    else if (imp.kind === 'table') ns[imp.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    else ns[imp.name] = new WebAssembly.Global({ value: 'i32', mutable: imp.module !== 'env' || imp.name === '__stack_pointer' },
      imp.name === '__memory_base' ? MEM_BASE : imp.name === '__stack_pointer' ? MEM_BASE - 16 : 0);
  }
  let inst;
  for (let i = 0; i < 4 && !inst; i++) {
    try { inst = new WebAssembly.Instance(mod, imports); } catch (e) {
      const t = /table import .*? is smaller than initial (\d+)/.exec(e.message);
      if (!t) throw e;
      for (const ns of Object.values(imports)) {
        for (const [k, v] of Object.entries(ns)) if (v instanceof WebAssembly.Table) ns[k] = new WebAssembly.Table({ initial: Number(t[1]), element: 'anyfunc' });
      }
    }
  }
  if (typeof inst?.exports.duckdb_library_version !== 'function') throw new Error('no duckdb_library_version() in this build');
  const ptr = inst.exports.duckdb_library_version();
  const mem = new Uint8Array(memory.buffer);
  let end = ptr;
  while (mem[end] && end - ptr < 64) end++;
  const v = new TextDecoder().decode(mem.subarray(ptr, end));
  if (!/^v\d+\.\d+\.\d+/.test(v)) throw new Error(`unexpected version string "${v}"`);
  return v.match(/^v\d+\.\d+\.\d+/)[0];
}

async function engineOf(wasmVersion) {
  const c = loadCache();
  if (c.wasm[wasmVersion]) return c.wasm[wasmVersion];
  const r = await get(`https://cdn.jsdelivr.net/npm/${WASM_PKG}@${wasmVersion}/dist/duckdb-mvp.wasm`);
  if (!r) throw new Error(`${WASM_PKG}@${wasmVersion}: no dist/duckdb-mvp.wasm`);
  const engine = engineFromWasm(new Uint8Array(await r.arrayBuffer()));
  c.wasm[wasmVersion] = engine;
  saveCache();
  return engine;
}

// ---------------------------------------------------------------- matching

let wasmList;
async function wasmVersions() {
  wasmList ??= (await registryVersions(WASM_PKG)).filter((v) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v) && cmp(v, OLDEST_WASM) >= 0).sort(cmp);
  return wasmList;
}

/** The DuckDB-WASM build whose engine is `engine` (stable preferred, then newest). */
async function wasmFor(engine) {
  const vs = await wasmVersions();
  if (!vs.length) throw new NoMatch();
  // Usually the newest build is the one (OpenMausBot tracks current DuckDB).
  let best = -1;
  const newest = await engineOf(vs.at(-1));
  if (cmpEngine(newest, engine) < 0) throw new NoMatch();
  if (cmpEngine(newest, engine) === 0) best = vs.length - 1;
  else {
    // Binary search: the last build whose engine is <= the one we want.
    let lo = 0, hi = vs.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cmpEngine(await engineOf(vs[mid]), engine) <= 0) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0 || cmpEngine(await engineOf(vs[best]), engine) !== 0) throw new NoMatch();
  }
  // Prefer a stable release with the same engine, if one is at or below it.
  for (let i = best; i >= 0; i--) {
    if (!isStable(vs[i])) continue;
    const e = await engineOf(vs[i]);
    if (cmpEngine(e, engine) === 0) return { wasm: vs[i], engine };
    if (cmpEngine(e, engine) < 0) break;
  }
  return { wasm: vs[best], engine };
}

/** The @duckdb/node-api version an OpenMausBot release pins ('' if none). */
async function ombNodeApi(version) {
  const c = loadCache();
  if (version in c.omb) return c.omb[version];
  const r = await get(`https://raw.githubusercontent.com/${OMB_REPO}/v${version}/package.json`, { timeout: 30_000 });
  const pin = r ? ((await r.json()).dependencies?.['@duckdb/node-api'] ?? '') : '';
  c.omb[version] = pin;
  saveCache();
  return pin;
}

// ---------------------------------------------------------------- commands

const out = (obj) => { for (const [k, v] of Object.entries(obj)) console.log(`${k}=${v}`); };

const commands = {
  async engine([v]) {
    if (!v) throw new Error('usage: engine <duckdb-wasm version>');
    out({ wasm: v, engine: await engineOf(v) });
  },
  async cached([v]) {
    const e = v && loadCache().wasm[v];
    if (!e) throw new NoMatch();
    out({ wasm: v, engine: e });
  },
  async match([nodeApi]) {
    if (!nodeApi) throw new Error('usage: match <node-api version>');
    out({ node_api: nodeApi, ...(await wasmFor(nodeApiEngine(nodeApi))) });
  },
  async 'omb-match'([upTo]) {
    const all = (await registryVersions(OMB_PKG)).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    const candidates = all.filter((v) => !upTo || cmp(v, upTo) <= 0).sort(cmp).reverse().slice(0, OMB_LOOKBACK);
    for (const omb of candidates) {
      const pin = await ombNodeApi(omb);
      if (!pin) continue;
      try { out({ omb, node_api: pin, ...(await wasmFor(nodeApiEngine(pin))) }); return; } catch (e) { if (!(e instanceof NoMatch)) throw e; }
    }
    throw new NoMatch();
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(2);
}
try {
  await commands[cmd](args);
} catch (e) {
  if (e instanceof NoMatch) process.exit(3);
  console.error(`duckdb-wasm: ${e.message}`);
  process.exit(2);
}
