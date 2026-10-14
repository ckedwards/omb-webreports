// The published site's Worker, deployed only when the site has a password
// (sudo webdata-admin deploy password set). Without one, the site is plain
// static assets on Cloudflare and no Worker code runs.
//
// webdata-deploy puts `const LOGIN_PAGE = <deploy/login.html>;` in front of
// this file and uploads the password as the SITE_PASSWORD secret. Every request
// needs the site's cookie. A browser asking for a page without it gets the
// password form at that page's own address (so it works inside an iPhone
// home-screen app too, which keeps its own cookies); anything else gets a bare
// 401. The cookie is "<expiry>.<HMAC-SHA256 of the expiry, keyed by the
// password>": nothing to store, and a new password signs every device out.
/* global LOGIN_PAGE */

const COOKIE = 'omb_site';
const DAYS = 400; // the longest browsers keep a cookie
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};
const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = async (password, exp) => `${exp}.${b64url(await hmac(password, `omb-webreports-site:${exp}`))}`;

async function signedIn(request, password) {
  const m = /(?:^|;\s*)omb_site=([0-9]{1,12})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('cookie') || '');
  if (!m || Number(m[1]) * 1000 < Date.now()) return false;
  const want = enc.encode(await token(password, m[1]));
  const got = enc.encode(`${m[1]}.${m[2]}`);
  return want.length === got.length && crypto.subtle.timingSafeEqual(want, got);
}

/** Compare MACs of the two, not the strings: equal length, constant time. */
async function passwordRight(given, password) {
  const [a, b] = await Promise.all([hmac('omb-webreports-login', given), hmac('omb-webreports-login', password)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plain = (status, text, extra = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...extra } });

function loginPage(url, status, error = '') {
  const html = LOGIN_PAGE.replaceAll('{{ACTION}}', esc(url.pathname + url.search)).replaceAll('{{ERROR}}', esc(error));
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } });
}
const wantsPage = (request) =>
  request.headers.get('sec-fetch-mode') === 'navigate' || /text\/html/.test(request.headers.get('accept') || '');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const password = env.SITE_PASSWORD;
    if (!password) return plain(503, 'This site has no password set yet.');

    if (request.method === 'POST') {
      if (Number(request.headers.get('content-length') || 0) > 4096) return plain(413, 'Too large.');
      let given = '';
      try { given = String((await request.formData()).get('password') || ''); } catch { return loginPage(url, 400, 'Try again.'); }
      if (!(await passwordRight(given, password))) {
        await scheduler.wait(1000); // slows guessing a little; a long password does the rest
        return loginPage(url, 401, 'That password isn’t right.');
      }
      const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
      return new Response(null, {
        status: 303,
        headers: {
          location: url.pathname + url.search,
          'set-cookie': `${COOKIE}=${await token(password, exp)}; Max-Age=${DAYS * 86400}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Read-only.', { allow: 'GET, HEAD' });

    if (url.pathname === '/_logout') {
      return new Response(null, {
        status: 303,
        headers: { location: '/', 'set-cookie': `${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store' },
      });
    }
    if (!(await signedIn(request, password))) return wantsPage(request) ? loginPage(url, 401) : plain(401, 'Sign in first.');

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
    // Only the signed-in browser may keep a copy (revalidated by ETag, as on the tailnet).
    out.headers.set('cache-control', 'private, no-cache');
    return out;
  },
};
