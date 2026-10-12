// Run by webdata-admin pair (as root): a pairing code for a new device, made
// with webdata-skills' OpenMausBot session (the only login on this machine
// once OpenMausBot is isolated, which is also why `openmausbot pair` stops
// working). Full access unless --chat-only.
//
//   node _admin-pair.mjs [--label NAME] [--chat-only]

import { execFileSync } from 'node:child_process';

import { OMB_URL } from './_config.mjs';
import { omb } from './_skills.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const chatOnly = args.includes('--chat-only');
const label = (valueOf('--label') ?? (chatOnly ? 'chat-only device' : 'browser')).slice(0, 80);

/** The HTTPS address tailscale serve gives OpenMausBot, if it has one. */
function servedAddress() {
  const port = new URL(OMB_URL).port || '80';
  let text = '';
  try { text = execFileSync('tailscale', ['serve', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); } catch { return null; }
  let site = null;
  for (const line of text.split('\n')) {
    const head = /^(https:\/\/\S+)/.exec(line);
    if (head) site = head[1].replace(/\/$/, '');
    else if (site && new RegExp(`^\\|-- / +proxy http://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(line.trim())) return site;
  }
  return null;
}

try {
  const r = await omb('POST', '/api/auth/pairing', { label, ...(chatOnly ? { scopes: ['client'] } : {}) });
  const base = servedAddress() ?? (r.url && !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(r.url) ? new URL(r.url).origin : null);
  const mins = Math.round((Number(new Date(r.expiresAt)) - Date.now()) / 60_000);
  console.log(`pairing code  ${r.code}   (${chatOnly ? 'chat only' : 'full access'}, "${label}", expires in ${mins} min)`);
  console.log(base
    ? `open          ${base}/pair#code=${r.code}\n              (or ${base}/pair and type the code)`
    : 'open          /pair on the address you use for OpenMausBot, and type the code');
  console.log('afterwards    see or revoke the device in OpenMausBot: Settings → Remote access');
} catch (e) {
  console.error(e.message);
  if (e.status === 401 || e.status === 403) {
    console.error('pair makes codes with webdata-skills\' session, so it needs a working one: create a pairing code on a device that is still signed in (Settings → Remote access), then: sudo webdata-admin skills login --code <code>');
  }
  process.exit(1);
}
