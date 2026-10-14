#!/usr/bin/env node
// webdata-admin deploy: publishing pages to the internet, on Cloudflare. Run by
// webdata-admin (as root); see its usage. bin/webdata-deploy (the service) does
// the deploying; bin/_deploy.mjs says what a published page includes.
//
//   setup [--account ID] [--worker NAME]   the Cloudflare account, the Worker's name and an API
//                                          token (asked for; or on stdin without a terminal)
//   add <slug>...                          publish a page, with the databases its report.json lists now
//   remove <slug>...                       take a page off the internet
//   password set|off                       one password for the whole published site (asked for, twice)
//   status                                 what's published, where, and how the last deploy went
//   now                                    deploy now instead of waiting for a change
//   disable                                stop deploying (the site stays online as last deployed)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, REPORTS_DIR } from './_config.mjs';
import { DEPLOY_CONFIG, DEPLOY_SECRETS, DEPLOY_STATE, SLUG, WORKER, loadConfig, readJSON, readInside, reportDatabases } from './_deploy.mjs';

const UNIT = 'webdata-deploy.service';
const API = 'https://api.cloudflare.com/client/v4';
const MIN_PASSWORD = 12;
const ROOT_USER = process.getuid?.() === 0;

const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

function writeFile(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
const saveConfig = (c) => writeFile(DEPLOY_CONFIG, JSON.stringify(c, null, 2) + '\n', 0o644);
const loadSecrets = () => readJSON(DEPLOY_SECRETS, {}) || {};
const saveSecrets = (s) => writeFile(DEPLOY_SECRETS, JSON.stringify(s) + '\n', 0o600);

function systemctl(...args) {
  if (!ROOT_USER) { console.log(`  (not root: skipped systemctl ${args.join(' ')})`); return true; }
  return spawnSync('systemctl', args, { stdio: 'inherit' }).status === 0;
}
/** The service reads the secrets once, at start (a systemd credential): restart it after a change. */
const restart = () => systemctl('enable', '-q', UNIT) && systemctl('restart', UNIT);

/** A line from the terminal without echoing it (bash's read -s), or from stdin without one. */
function secret(prompt) {
  if (!process.stdin.isTTY) {
    const all = fs.readFileSync(0, 'utf8');
    return all.split('\n')[0].trim();
  }
  const r = spawnSync('bash', ['-c', 'read -rs -p "$1" v; echo >&2; printf %s "$v"', 'bash', prompt], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  return (r.stdout || '').trim();
}
function ask(prompt, def) {
  if (!process.stdin.isTTY) return def;
  const r = spawnSync('bash', ['-c', 'read -r -p "$1" v; printf %s "$v"', 'bash', `${prompt}${def ? ` [${def}]` : ''}: `], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  return (r.stdout || '').trim() || def;
}

async function cf(token, url) {
  try {
    const r = await fetch(`${API}${url}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok && body.success !== false, status: r.status, body };
  } catch (e) { return { ok: false, status: 0, body: { errors: [{ message: e.message }] } }; }
}
const cfError = (r) => (r.body?.errors || []).map((e) => `${e.code ? `${e.code} ` : ''}${e.message}`).join('; ') || `HTTP ${r.status}`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? '';
}

/** The page's report.json databases, read as the service would (no links, inside REPORTS). */
function pageDatabases(slug) {
  if (!SLUG.test(slug)) die(`"${slug}" isn't a report name (lowercase-kebab-case)`);
  let root;
  try { root = fs.realpathSync(REPORTS_DIR); } catch { die(`no reports folder at ${REPORTS_DIR}`); }
  const dir = path.join(REPORTS_DIR, slug);
  let st;
  try { st = fs.lstatSync(dir); } catch { die(`no report ${slug} in ${REPORTS_DIR}`); }
  if (!st.isDirectory()) die(`${dir} isn't a plain folder`);
  const text = readInside(root, path.join(dir, 'report.json'))?.data?.toString('utf8');
  if (text == null) die(`${slug} has no readable report.json`);
  const dbs = reportDatabases(text);
  if (dbs == null) die(`${slug}/report.json isn't valid JSON`);
  return dbs;
}

const addressOf = () => readJSON(DEPLOY_STATE, {})?.url || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const active = () => spawnSync('systemctl', ['is-active', '--quiet', UNIT]).status === 0;

/**
 * Deploy now and say how it went, so a change (or a bad token) shows here and
 * not only in `deploy status`. The service deploys on SIGHUP; state.json says
 * when its last attempt was and how it ended.
 */
async function deployAndReport() {
  if (!ROOT_USER) { console.log('  (not root: not deploying)'); return true; }
  if (!loadConfig().account_id || !fs.existsSync(DEPLOY_SECRETS)) return true;
  for (let i = 0; i < 20 && !active(); i++) await sleep(500);
  if (!active()) { console.log(`${UNIT} isn't running: journalctl -u ${UNIT} -n 50`); return false; }
  await sleep(1500); // a service just (re)started: let it get to its signal handler
  // An attempt that started after we asked, and has finished.
  const asked = new Date().toISOString();
  const done = (st) => (st.attempt_started || '') >= asked && (st.last_attempt || '') >= st.attempt_started;
  spawnSync('systemctl', ['kill', '-s', 'HUP', '--kill-whom=main', UNIT]);
  process.stdout.write('deploying');
  const until = Date.now() + 5 * 60_000;
  let st = {};
  while (Date.now() < until) {
    await sleep(2000);
    process.stdout.write('.');
    st = readJSON(DEPLOY_STATE, {}) || {};
    if (done(st)) break;
  }
  console.log();
  if (!done(st)) {
    console.log('still deploying after 5 minutes: sudo webdata-admin deploy status');
    return false;
  }
  if (st.error && st.error_at === st.last_attempt) {
    console.log(`DEPLOY FAILED: ${st.error}`);
    if (/No access|Authentication error|\b403\b|10000|Unauthorized/i.test(st.error)) {
      console.log('The API token can\'t deploy Workers in this account. Create one from the "Edit Cloudflare Workers" template');
      console.log('(Account Resources: Include → this account; it must list "Workers Scripts: Edit"), then: sudo webdata-admin deploy setup');
    } else {
      console.log('It retries on its own. Details: journalctl -u webdata-deploy -n 50');
    }
    return false;
  }
  console.log(`deployed: ${st.url ? `${st.url}/` : '(address unknown)'}${st.files ? ` (${st.files} files)` : ''}`);
  for (const n of st.notes || []) console.log(`  note: ${n}`);
  return true;
}

// ---------------------------------------------------------------- commands

async function setup(args) {
  const raw = readJSON(DEPLOY_CONFIG, {}) || {};
  const conf = loadConfig();
  const secrets = loadSecrets();
  let account = flag(args, '--account') ?? ask('Cloudflare account ID (Workers & Pages → Account details, or the address bar: dash.cloudflare.com/<id>/…)', conf.account_id || '');
  let worker = flag(args, '--worker') ?? ask('Worker name (the address becomes https://<name>.<your subdomain>.workers.dev)', conf.worker || 'omb-webreports');
  account = (account || '').trim().toLowerCase();
  worker = (worker || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(account)) die('the account ID is 32 hexadecimal characters (dashboard: Workers & Pages → Account details)');
  if (!WORKER.test(worker)) die(`"${worker}" can't be a Worker name: lowercase letters, digits and -, at most 63`);

  console.log('An API token from the "Edit Cloudflare Workers" template (https://dash.cloudflare.com/profile/api-tokens → Create Token).');
  let token = secret(secrets.token ? 'API token (Enter keeps the current one): ' : 'API token: ');
  if (!token) token = secrets.token || '';
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) die('that doesn\'t look like a Cloudflare API token');

  let check = await cf(token, '/user/tokens/verify');
  if (!check.ok) check = await cf(token, `/accounts/${account}/tokens/verify`);
  if (!check.ok) die(`Cloudflare didn't accept the token: ${cfError(check)}`);
  // wrangler's first calls. (Listing the account's Workers succeeds even without
  // permission, so it proves nothing.) 403: the token lacks Workers Scripts on this account.
  const sub = await cf(token, `/accounts/${account}/workers/subdomain`);
  if (sub.status === 403 || sub.status === 401) {
    die(`the token can't use Workers in account ${account}: ${cfError(sub)}.
  Create a token from the "Edit Cloudflare Workers" template with Account Resources: Include → this account
  (its summary must list "Workers Scripts: Edit"), then run setup again.`);
  }
  const subdomain = sub.ok ? sub.body?.result?.subdomain : null;

  saveSecrets({ ...secrets, token });
  saveConfig({ ...raw, account_id: account, worker, password: conf.password, pages: raw.pages || {} });
  console.log(`saved: ${DEPLOY_CONFIG}; the token in ${DEPLOY_SECRETS} (root only)`);
  if (!subdomain) {
    console.log(`\nThe account has no workers.dev subdomain yet. In the dashboard open Workers & Pages once and pick one;`);
    console.log('the first deploy fails until then, and retries on its own.');
  }
  restart();
  const url = subdomain ? `https://${worker}.${subdomain}.workers.dev/` : `https://${worker}.<subdomain>.workers.dev/`;
  console.log(`\nThe site goes to ${url}${Object.keys(conf.pages).length ? '' : ': the front page only, until you add pages'}.`);
  const ok = await deployAndReport();
  console.log('  sudo webdata-admin deploy add <slug>      (webdata-ls lists them)');
  console.log('  sudo webdata-admin deploy status');
  if (!ok) process.exit(1);
}

async function add(slugs) {
  if (!slugs.length) die('sudo webdata-admin deploy add <slug>...');
  const raw = readJSON(DEPLOY_CONFIG, {}) || {};
  const conf = loadConfig();
  raw.pages = raw.pages || {};
  for (const slug of slugs) {
    const dbs = pageDatabases(slug);
    const was = conf.pages[slug];
    raw.pages[slug] = { databases: dbs, added: new Date().toISOString() };
    const what = dbs.length ? `the page and its data: ${dbs.join(', ')}` : 'the page (it reads no databases)';
    console.log(`${was ? 'updated' : 'published'} ${slug}: ${what}`);
  }
  saveConfig(raw);
  const url = addressOf();
  console.log(conf.password ? 'Behind the site password.' : 'Anyone with the link can open it.');
  if (!conf.account_id) { console.log('Deploying isn\'t set up yet: sudo webdata-admin deploy setup'); return; }
  if (!(await deployAndReport())) process.exit(1);
  const live = addressOf() || url;
  if (live) for (const slug of slugs) console.log(`  ${live}/reports/${slug}/`);
}

async function remove(slugs) {
  if (!slugs.length) die('sudo webdata-admin deploy remove <slug>...');
  const raw = readJSON(DEPLOY_CONFIG, {}) || {};
  raw.pages = raw.pages || {};
  for (const slug of slugs) {
    if (!raw.pages[slug]) { console.log(`${slug} isn't published`); continue; }
    delete raw.pages[slug];
    console.log(`removed ${slug}`);
  }
  saveConfig(raw);
  if (!(await deployAndReport())) process.exit(1);
}

async function password(args) {
  const raw = readJSON(DEPLOY_CONFIG, {}) || {};
  const secrets = loadSecrets();
  if (args[0] === 'set') {
    const pw = secret('New password for the published site: ');
    if (pw.length < MIN_PASSWORD) die(`use at least ${MIN_PASSWORD} characters (anyone on the internet can try passwords)`);
    if (process.stdin.isTTY && secret('Again: ') !== pw) die("they don't match");
    saveSecrets({ ...secrets, password: pw });
    saveConfig({ ...raw, password: true });
    restart();
    console.log('The published site asks for this password once per device (and once inside each home-screen app).');
    console.log('A new password signs every device out.');
    if (!(await deployAndReport())) process.exit(1);
  } else if (args[0] === 'off') {
    delete secrets.password;
    saveSecrets(secrets);
    saveConfig({ ...raw, password: false });
    restart();
    console.log('The published site is open to anyone with the link again.');
    console.log('(The old password stays on Cloudflare as an unused secret: Workers & Pages → the Worker → Settings.)');
    if (!(await deployAndReport())) process.exit(1);
  } else {
    die('sudo webdata-admin deploy password set|off');
  }
}

// ---------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'setup': await setup(args); break;
  case 'add': await add(args); break;
  case 'remove': await remove(args); break;
  case 'password': await password(args); break;
  case 'now':
    if (!(await deployAndReport())) process.exit(1);
    break;
  case 'disable':
    systemctl('disable', '--now', UNIT);
    console.log('Stopped deploying. The published site stays online as last deployed; to take it down,');
    console.log(`delete the Worker ${loadConfig().worker || ''} in the dashboard (Workers & Pages → it → Settings → Delete).`);
    console.log('Start again with: sudo webdata-admin deploy setup');
    break;
  case 'status':
  case undefined: {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'webdata-deploy'), 'status'], { stdio: 'inherit' });
    if (ROOT_USER && fs.existsSync(DEPLOY_SECRETS)) {
      const a = spawnSync('systemctl', ['is-active', UNIT], { encoding: 'utf8' }).stdout.trim();
      console.log(`service   ${UNIT} ${a}`);
    }
    process.exit(r.status ?? 1);
    break;
  }
  default: die(`unknown: deploy ${cmd} (setup, add, remove, password set|off, status, now, disable)`);
}
