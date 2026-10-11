// kit.js: shared runtime for ~/webdata reports. Plain ES module, no build step.
//
//   import { report, chart, table, stats, segmented, fmt } from '/lib/kit.js';
//   report({
//     databases: ['mybot'],              // attaches /data/mybot.duckdb as "mybot"
//     async render(db) {                   // called on load, data change, theme change, resize
//       const rows = await db.query('SELECT * FROM mybot.main.batting_stats');
//       ...
//     },
//   });
//
// Freshness is ETag-driven: the server sends Cache-Control: no-cache, and kit
// polls HEAD on each attached .duckdb (and on this page) while the page is
// visible. A changed database is re-attached and render() runs again; a
// changed page reloads itself.
//
// Load speed: query results are cached in IndexedDB per database ETag, so a
// revisit with unchanged data renders without starting DuckDB-WASM (which
// costs ~1s of compile even when cached), and the server bakes each report's
// first-render results so a first visit doesn't wait for it either. See
// "result cache" and "baked first render" below.

const DUCKDB_WASM = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm';
const POLL_MS = 15000;

// Load-time marks, readable in devtools: performance.getEntriesByType('mark')
const mark = (name) => performance.mark(`kit:${name}`);
mark('loaded');

// ---------------------------------------------------------------- engine

let enginePromise = null;

/** Lazily start DuckDB-WASM (single-threaded build, worker from jsDelivr). */
function engine() {
  enginePromise ??= (async () => {
    mark('engine-start');
    const duckdb = await import(DUCKDB_WASM);
    mark('engine-imported');
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: 'text/javascript' }));
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    mark('engine-instantiated');
    URL.revokeObjectURL(workerUrl);
    const conn = await db.connect();
    // Freshness comes from ETags (see attach); DuckDB's own block cache would
    // keep serving the old file's bytes for the same URL.
    await conn.query('SET enable_external_file_cache = false');
    mark('engine-ready');
    return { db, conn };
  })();
  return enginePromise;
}

/** Arrow value -> plain JS: BIGINT/HUGEINT -> Number, DECIMAL -> Number,
 *  DATE/TIMESTAMP -> Date. (SQL literals like 0.31 are DECIMAL in DuckDB.) */
function plain(value, type) {
  if (value == null) return null;
  const t = String(type);
  // Arrow hands decimals over as the unscaled integer: 0.31 arrives as 31.
  if (t.startsWith('Decimal')) return Number(BigInt(value)) / 10 ** (type.scale ?? 0);
  if (t.startsWith('Date') || t.startsWith('Timestamp')) return value instanceof Date ? value : new Date(Number(value));
  if (typeof value === 'bigint') return Number(value);
  if (t.startsWith('List') || t.startsWith('FixedSizeList')) return [...value].map((v) => plain(v, type.children[0].type));
  if (t.startsWith('Struct')) return Object.fromEntries(type.children.map((c) => [c.name, plain(value[c.name], c.type)]));
  return value;
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
const quoteString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const dbUrl = (name) => new URL(`/data/${encodeURIComponent(name)}.duckdb`, location.href).href;

/** ETag (or Last-Modified) of a URL via HEAD; bypasses the HTTP cache. */
async function head(url) {
  const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const modified = r.headers.get('last-modified');
  return { tag: r.headers.get('etag') || modified, modified: modified ? new Date(modified) : null };
}

// ---------------------------------------------------------------- databases
//
// `known` is what HEAD says each database currently is; `inEngine` is what the
// engine has attached. They differ until a query actually needs the engine:
// with the result cache, an unchanged database never starts DuckDB at all.

const known = new Map();    // name -> { tag, modified }
const inEngine = new Map(); // name -> tag attached in the engine

/** Attach (or re-attach) every known database whose version the engine lacks.
 *  Serialized: parallel queries share one pass instead of racing to ATTACH. */
let attaching = Promise.resolve();
function ensureAttached() {
  const run = attaching.then(attachPass, attachPass);
  attaching = run.catch(() => {});
  return run;
}

async function attachPass() {
  const { db, conn } = await engine();
  for (const [name, info] of known) {
    if (inEngine.get(name) === info.tag) continue;
    const url = dbUrl(name);
    if (inEngine.has(name)) {
      await conn.query(`DETACH ${quoteIdent(name)}`);
      // DuckDB-WASM keeps a downloaded file in its registry by URL; drop it so
      // the re-attach fetches the new version (revalidated by ETag).
      await db.dropFile(url).catch(() => {});
    }
    await conn.query(`ATTACH ${quoteString(url)} AS ${quoteIdent(name)} (READ_ONLY)`);
    inEngine.set(name, info.tag);
    mark(`attached:${name}`);
  }
  return conn;
}

/** Register databases from /data by name. Each becomes a SQL database: name.schema.table. */
export async function connect(names = []) {
  await Promise.all(names.filter((n) => !known.has(n)).map(async (n) => known.set(n, await head(dbUrl(n)))));
  return { query };
}

/** Re-check every database's ETag. Returns true if any changed. */
async function refreshDatabases() {
  let changed = false;
  await Promise.all([...known].map(async ([name, info]) => {
    const now = await head(dbUrl(name));
    if (now.tag !== info.tag) { known.set(name, now); changed = true; }
  }));
  if (changed) pruneCache();
  return changed;
}

// ---------------------------------------------------------------- result cache
//
// Query results are kept in IndexedDB keyed by page + SQL + the ETag of every
// known database. Same data version -> same rows, so a revisit renders
// without starting DuckDB. New data -> new ETag -> new key -> real query.
// Pass { cache: false } for SQL whose result isn't determined by the
// databases alone (now(), random(), read_parquet of other URLs, ...).

let idbPromise = null;
function idb() {
  idbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open('kit-results', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('results');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return idbPromise;
}

async function idbRun(mode, fn) {
  const store = await idb();
  if (!store) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = store.transaction('results', mode);
      const req = fn(tx.objectStore('results'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

const versions = () => [...known].sort(([a], [b]) => a.localeCompare(b)).map(([n, i]) => `${n}=${i.tag}`).join(',');
const cacheKey = (sql) => `${location.pathname}\n${versions()}\n${sql}`;

/** Drop this page's cached results for database versions that are gone. */
function pruneCache() {
  const prefix = `${location.pathname}\n`;
  const current = `${prefix}${versions()}\n`;
  idbRun('readwrite', (store) => {
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (cur.key.startsWith(prefix) && !cur.key.startsWith(current)) store.delete(cur.key);
      cur.continue();
    };
    return req;
  });
}

// ---------------------------------------------------------------- baked first render
//
// webdata-bake (run by webdata-sync when a report's data or page changes)
// opens each report headless with ?kit-bake, records every cached query the
// first render ran, and writes the rows to the report's initial.json. The
// page links that file (a preload in the webdata:modules block), so a first
// visit, or the first visit after new data, renders without DuckDB-WASM.
// Entries are used only for the database versions they were made from, like
// the result cache. One exception: if the data moved on since the bake (the
// seconds before the next bake), the first render uses them anyway, says
// "Updating…", and redraws as soon as the engine has the new data.

const BAKE = new URLSearchParams(location.search).has('kit-bake');
const recorded = new Map();   // bake mode: sql -> rows of the first render
let recording = false;
let baked = null;             // Promise<{ versions, results: Map<sql, rows> } | null>
let staleOk = false;          // first render only: may use outdated baked rows
let servedStale = false;

// JSON can't hold Date, NaN or Infinity; tag them.
function bakeReplacer(k, v) {
  const o = this[k];
  if (o instanceof Date) return { $date: o.getTime() };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
  return v;
}
function bakeReviver(k, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$date') return new Date(v.$date);
    if (keys.length === 1 && keys[0] === '$num') return Number(v.$num);
  }
  return v;
}

/** Bake mode: the first render's results as initial.json content. */
if (BAKE) {
  window.__kitBake = () => JSON.stringify({
    format: 1,
    versions: versions(),
    results: [...recorded].map(([sql, rows]) => ({ sql, rows })),
  }, bakeReplacer);
}

function loadBaked() {
  baked ??= (async () => {
    const link = document.querySelector('link[data-kit-initial]');
    if (BAKE || !link) return null;
    try {
      const r = await fetch(link.href);
      if (!r.ok) return null;
      const data = JSON.parse(await r.text(), bakeReviver);
      if (data.format !== 1) return null;
      mark('baked-loaded');
      return { versions: data.versions, results: new Map(data.results.map((e) => [e.sql, e.rows])) };
    } catch { return null; }
  })();
  return baked;
}

async function fromBaked(sql) {
  const b = await loadBaked();
  const rows = b?.results.get(sql);
  if (!rows) return null;
  if (b.versions !== versions()) {
    if (!staleOk) return null;
    servedStale = true;
  }
  mark('baked-used');
  return structuredClone(rows);
}

/**
 * Run SQL; returns an array of plain objects (BIGINT, HUGEINT, DECIMAL ->
 * Number; DATE/TIMESTAMP -> Date). Results are cached per database version
 * unless { cache: false }.
 */
export async function query(sql, { cache = true } = {}) {
  const key = cache && known.size ? cacheKey(sql) : null;
  if (key && !BAKE) {
    const hit = await idbRun('readonly', (store) => store.get(key));
    if (hit) return hit.rows;
    const bakedRows = await fromBaked(sql);
    if (bakedRows) return bakedRows;
  }
  const conn = await ensureAttached();
  const result = await conn.query(sql);
  const fields = result.schema.fields;
  const rows = [];
  for (const row of result) {
    const obj = {};
    for (const f of fields) obj[f.name] = plain(row[f.name], f.type);
    rows.push(obj);
  }
  if (key && BAKE) { if (recording) recorded.set(sql, structuredClone(rows)); }
  else if (key) idbRun('readwrite', (store) => store.put({ rows, at: Date.now() }, key));
  return rows;
}

// ---------------------------------------------------------------- report loop

function statusEl() {
  let el = document.querySelector('[data-kit-status]');
  if (!el) {
    el = document.createElement('div');
    el.dataset.kitStatus = '';
    (document.querySelector('.app-header .titles') || document.body).append(el);
  }
  el.classList.add('kit-status');
  return el;
}

function showError(err) {
  let box = document.querySelector('.kit-error');
  if (!err) { box?.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.className = 'kit-error';
    (document.querySelector('main') || document.body).prepend(box);
  }
  const strong = document.createElement('strong');
  strong.textContent = 'Something went wrong. ';
  box.replaceChildren(strong, document.createTextNode(err.message || String(err)));
  console.error(err);
  window.__reportError?.('kit', err.stack || err.message || String(err));
}

/**
 * Run a report: attach databases, render, keep it live.
 * render(db, { reason }) must be idempotent: it is called again on data
 * change ('data'), color-scheme change ('theme') and width change ('resize').
 * Returns { redraw(reason) } for controls that change what is shown.
 * warm: false skips starting DuckDB-WASM in the background after the first
 * render (for a page with no controls that run new queries).
 */
export function report({ databases = [], render, poll = POLL_MS, warm = true }) {
  const status = statusEl();
  const main = document.querySelector('main');
  let pageTag = null;
  let busy = null;
  let lastWidth = window.innerWidth;

  const setStatus = (state, text) => { status.dataset.state = state; status.textContent = text; };
  const updatedText = () => {
    const times = [...known.values()].map((i) => i.modified).filter(Boolean);
    return times.length ? `Data updated ${fmt.ago(new Date(Math.max(...times)))}` : 'Live';
  };

  /** Returns true if render() succeeded. */
  async function draw(reason) {
    if (busy) return busy.then(() => draw(reason));
    busy = (async () => {
      main?.classList.add('loading');
      try {
        await render({ query }, { reason });
        mark(`rendered:${reason}`);
        showError(null);
        setStatus('ok', updatedText());
        return true;
      } catch (err) {
        showError(err);
        setStatus('error', 'Error');
        return false;
      } finally {
        main?.classList.remove('loading');
      }
    })();
    try { return await busy; } finally { busy = null; }
  }

  async function check() {
    if (document.hidden) return;
    try {
      const [page, changed] = await Promise.all([head(location.pathname), refreshDatabases()]);
      if (pageTag && page.tag !== pageTag) { location.reload(); return; }
      if (changed) await draw('data');
      else setStatus('ok', updatedText());
      refreshFreshness();
    } catch (err) {
      setStatus('error', 'Offline');
      console.warn(err);
    }
  }

  (async () => {
    setStatus('loading', 'Loading…');
    loadBaked();
    try {
      [{ tag: pageTag }] = await Promise.all([head(location.pathname), connect(databases)]);
    } catch (err) {
      showError(err);
      setStatus('error', 'Error');
      if (BAKE) document.documentElement.dataset.kitBake = 'error';
      return;
    }
    staleOk = recording = true;
    const ok = await draw('initial');
    staleOk = recording = false;
    if (BAKE) { document.documentElement.dataset.kitBake = ok ? 'ready' : 'error'; return; }
    if (servedStale) {
      // Drawn from a bake of older data: swap in the current data.
      servedStale = false;
      setStatus('loading', 'Updating…');
      await draw('data');
    }
    pruneCache();
    // A baked or cached render never started the engine. Start it once the
    // page is idle, so the first control that needs a new query doesn't wait
    // ~1-3 s for it; a touch before then starts it at once. Startup runs in
    // DuckDB's worker, so it doesn't block scrolling. Skipped for warm: false
    // and when the browser asks to save data.
    const warmUp = () => ensureAttached().catch(() => {});
    for (const type of ['pointerdown', 'keydown']) addEventListener(type, warmUp, { once: true, passive: true });
    if (warm && known.size && !navigator.connection?.saveData) {
      if (window.requestIdleCallback) requestIdleCallback(warmUp, { timeout: 2000 });
      else setTimeout(warmUp, 500);
    }
    setInterval(check, poll);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw('theme'));
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (Math.abs(window.innerWidth - lastWidth) < 24) return;
        lastWidth = window.innerWidth;
        draw('resize');
      }, 200);
    });
  })();

  // Call app.redraw() after a filter/control changes.
  return { redraw: (reason = 'input') => draw(reason) };
}

// ---------------------------------------------------------------- charts

/** Resolved theme colors (charts need real values, not var()). */
export function colors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'), surface: v('--surface'),
    good: v('--status-good'), warning: v('--status-warning'),
    serious: v('--status-serious'), critical: v('--status-critical'),
    seqLow: v('--seq-low'), seqHigh: v('--seq-high'),
    divNeg: v('--div-neg'), divMid: v('--div-mid'), divPos: v('--div-pos'),
    page: v('--page'),
  };
}

/**
 * Render an Observable Plot chart into el with the house style.
 * Needs <script src="/lib/vendor/d3.min.js"> and plot.umd.min.js on the page.
 * options are Plot.plot options; width defaults to the element's width.
 */
export function chart(el, options) {
  const Plot = window.Plot;
  if (!Plot) throw new Error('chart(): load /lib/vendor/d3.min.js and /lib/vendor/plot.umd.min.js first');
  const c = colors();
  el.classList.add('kit-chart');
  const svg = Plot.plot({
    width: Math.max(280, el.clientWidth || 640),
    style: { fontFamily: 'inherit', fontSize: '12px', color: c.muted, background: 'transparent' },
    ...options,
    color: { range: c.series, ...options.color },
  });
  el.replaceChildren(svg);
  return svg;
}

/** Legend for >= 2 series: [{ label, color, line? }]. Text stays in ink. */
export function legend(el, items) {
  el.classList.add('legend');
  el.replaceChildren(...items.map(({ label, color, line }) => {
    const span = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = color;
    if (line) sw.className = 'line';
    span.append(sw, document.createTextNode(label));
    return span;
  }));
}

// ---------------------------------------------------------------- components

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};

/**
 * One stat tile: { label, value, note?, delta? }.
 * value is display text (format it with fmt first). delta is
 * { text: '+12 vs last week', direction: 'up'|'down'|'flat', good: true|false|null }:
 * the arrow follows direction, the color follows good (null = neutral),
 * so "ERA down" can be good and "runs allowed up" bad.
 */
export function stat({ label, value, note, delta }) {
  const tile = node('div', 'card stat');
  tile.append(node('div', 'label', label), node('div', 'value', value ?? '–'));
  if (delta) {
    const arrow = { up: '▲ ', down: '▼ ', flat: '■ ' }[delta.direction] ?? '';
    const tone = delta.good == null ? 'neutral' : delta.good ? 'good' : 'bad';
    tile.append(node('div', `delta ${tone}`, arrow + delta.text));
  }
  if (note) tile.append(node('div', 'note', note));
  return tile;
}

/** Fill a `.grid.stats` element with stat tiles. */
export function stats(el, items) {
  el.replaceChildren(...items.filter(Boolean).map(stat));
}

/**
 * Wire a `.segmented` button group, for tabs or filters.
 *   <div class="segmented" role="group" aria-label="View">
 *     <button type="button" data-value="batting" aria-pressed="true">Batting</button> ...
 * If an element with id = data-value exists, it's a panel: shown when its
 * button is selected, hidden otherwise (tabs). onChange(value) runs on every
 * change (filters: call app.redraw() there). Returns { get value() }.
 */
export function segmented(group, { onChange } = {}) {
  const buttons = [...group.querySelectorAll('button[data-value]')];
  let value = (buttons.find((b) => b.getAttribute('aria-pressed') === 'true') || buttons[0])?.dataset.value;
  const apply = () => {
    for (const b of buttons) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-pressed', String(on));
      const panel = document.getElementById(b.dataset.value);
      if (panel) panel.hidden = !on;
    }
  };
  for (const b of buttons) {
    b.type = 'button';
    b.addEventListener('click', () => {
      if (b.dataset.value === value) return;
      value = b.dataset.value;
      apply();
      onChange?.(value);
    });
  }
  apply();
  return { get value() { return value; } };
}

/** Replace el's content with an empty-state message. */
export function empty(el, text = 'No data yet.') {
  el.replaceChildren(node('p', 'empty', text));
}

/** Only absolute http(s) URLs may become links: data from feeds and scraped
 *  pages is untrusted, and a javascript: URL in href would run in this page.
 *  Relative URLs are refused too: from a scraped page they'd point at this site. */
function safeUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/**
 * A list of items: headlines, results, upcoming events.
 * items: [{ title, url?, source?, time?, meta?, summary? }]
 *   url      the title links to it (opens outside the page); only absolute
 *            http(s) URLs are linked, anything else shows as plain text
 *   source   e.g. the publication; time: a Date, shown as "3 hours ago" / "in 2 days"
 *   meta     any other short text for the grey line ("Final", "Home")
 *   summary  one or two sentences, clamped to two lines
 */
export function feed(el, items, { empty: emptyText = 'Nothing here right now.' } = {}) {
  if (!items.length) { empty(el, emptyText); return; }
  const list = node('ul', 'feed');
  for (const it of items) {
    const li = node('li');
    const href = safeUrl(it.url);
    const title = node(href ? 'a' : 'span', 'title', it.title ?? '');
    if (href) Object.assign(title, { href, target: '_blank', rel: 'noopener noreferrer' });
    li.append(title);
    const meta = [it.source, it.time != null ? fmt.ago(it.time) : null, it.meta].filter(Boolean).join(' · ');
    if (meta) li.append(node('div', 'meta', meta));
    if (it.summary) li.append(node('p', 'summary', it.summary));
    list.append(li);
  }
  el.replaceChildren(list);
}

/**
 * "Updated 12 minutes ago" for one section, from when its data was collected
 * (the newest fetched_at). Older than staleAfter minutes, it becomes a warning:
 * the source, or the job collecting it, has probably stopped working. The text
 * stays current while the page is open (report() refreshes it on every check).
 */
export function freshness(el, when, { staleAfter = null } = {}) {
  el.classList.add('freshness');
  el.dataset.when = when == null ? '' : String(new Date(when).getTime());
  el.dataset.staleAfter = staleAfter ?? '';
  paintFreshness(el);
}

function paintFreshness(el) {
  const when = el.dataset.when ? Number(el.dataset.when) : null;
  const limit = el.dataset.staleAfter ? Number(el.dataset.staleAfter) : null;
  const stale = when == null || (limit != null && Date.now() - when > limit * 60_000);
  el.classList.toggle('stale', stale);
  el.textContent = when == null ? 'Not collected yet'
    : `Updated ${fmt.ago(when)}${stale ? ' · may be out of date' : ''}`;
}
const refreshFreshness = () => document.querySelectorAll('.freshness[data-when]').forEach(paintFreshness);

// ---------------------------------------------------------------- tables

/**
 * Sortable table. columns: [{ key, label?, format?(v,row), numeric? }].
 * Values are inserted as text (never HTML).
 */
export function table(el, rows, columns, { sort = null, desc = true } = {}) {
  columns = columns || Object.keys(rows[0] || {}).map((key) => ({ key }));
  for (const col of columns) col.numeric ??= rows.some((r) => typeof r[col.key] === 'number');
  let sortKey = sort;
  let sortDesc = desc;

  const paint = () => {
    const sorted = sortKey == null ? rows : [...rows].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x == null || y == null) return (x == null) - (y == null); // nulls last either way
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      return sortDesc ? -cmp : cmp;
    });
    const t = document.createElement('table');
    t.className = 'data';
    const tr = t.createTHead().insertRow();
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label ?? col.key;
      th.dataset.sort = col.key;
      if (col.numeric) th.className = 'n';
      if (col.key === sortKey) th.setAttribute('aria-sort', sortDesc ? 'descending' : 'ascending');
      th.onclick = () => {
        sortDesc = col.key === sortKey ? !sortDesc : col.numeric;
        sortKey = col.key;
        paint();
      };
      tr.append(th);
    }
    const body = t.createTBody();
    for (const row of sorted) {
      const r = body.insertRow();
      for (const col of columns) {
        const td = r.insertCell();
        const v = row[col.key];
        td.textContent = col.format ? col.format(v, row) : v instanceof Date ? fmt.date(v) : v ?? '';
        if (col.numeric) td.className = 'n';
      }
    }
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.append(t);
    el.replaceChildren(wrap);
  };
  paint();
}

// ---------------------------------------------------------------- formatting

export const fmt = {
  /** 1,284 / 0.31 */
  num: (n, digits) => n == null ? '–' : Number(n).toLocaleString(undefined,
    digits == null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  /** 12.9K / 4.2M */
  compact: (n) => n == null ? '–' : Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n),
  /** 0.488 -> 48.8% */
  pct: (n, digits = 1) => n == null ? '–' : `${(n * 100).toFixed(digits)}%`,
  /** .262 style (leading zero dropped), for rates like batting average */
  rate: (n, digits = 3) => n == null ? '–' : Number(n).toFixed(digits).replace(/^0(?=\.)/, ''),
  date: (d) => d == null ? '–' : new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
  datetime: (d) => d == null ? '–' : new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  /** "3 minutes ago", or "in 2 hours" for a future time */
  ago(d) {
    if (d == null) return '–';
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (!(Math.abs(s) >= 45)) return 'just now';
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, secs] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(s) >= secs) return rtf.format(-Math.round(s / secs), unit);
    }
    return 'just now';
  },
};

/**
 * Call onChange() whenever any URL's ETag changes. Polls HEAD while the page
 * is visible, and checks again when it becomes visible. For pages that read
 * JSON files rather than databases.
 */
export function watch(urls, onChange, { poll = POLL_MS } = {}) {
  const tags = new Map();
  const check = async () => {
    if (document.hidden) return;
    let changed = false;
    for (const url of urls) {
      try {
        const { tag } = await head(url);
        if (tags.has(url) && tags.get(url) !== tag) changed = true;
        tags.set(url, tag);
      } catch (err) { console.warn(err); }
    }
    if (changed) onChange();
  };
  check();
  setInterval(check, poll);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });
}

/** Fetch JSON, always revalidated (e.g. '/data/catalog.json'). */
export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
