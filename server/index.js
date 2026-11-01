import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Settings } from './lib/settings.js';
import { Auth } from './lib/auth.js';
import { loadSecret } from './lib/secret.js';
import { Tatum } from './lib/adapters/tatum.js';
import { Memory } from './lib/adapters/memory.js';
import { Learner } from './lib/learner.js';
import { startScan, getJob } from './lib/scanner.js';
import { detectChain } from './lib/chain.js';
import { pairsFor } from './lib/adapters/dexscreener.js';
import { sniffScore } from './lib/adapters/sniffers.js';
import { askJson } from './lib/adapters/llm.js';
import { purgeSession } from './lib/learner.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;

export function buildApp({ dataDir = DATA_DIR } = {}) {
  const store = new Store(dataDir);
  const secret = loadSecret(dataDir, store);
  const auth = new Auth(store, secret);
  const settings = new Settings(store, secret);
  const tatum = new Tatum(settings);
  const memory = new Memory(settings, store);
  const ctx = { store, settings, tatum, memory, auth };
  ctx.learner = new Learner(ctx);
  return ctx;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const buckets = new Map();
function limited(ip, name, max, perMs) {
  const k = name + ip, now = Date.now();
  const b = buckets.get(k) || { n: max, t: now };
  b.n = Math.min(max, b.n + ((now - b.t) / perMs) * max); b.t = now;
  if (b.n < 1) { buckets.set(k, b); return true; }
  b.n -= 1; buckets.set(k, b);
  if (buckets.size > 5000) for (const [kk, v] of buckets) if (now - v.t > 600000) buckets.delete(kk);
  return false;
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

async function body(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 65536) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function createServer(ctx) {
  const { store, settings, auth, memory, learner, tatum } = ctx;
  const staticRoots = [path.join(ROOT, 'dist'), path.join(ROOT, 'web', 'public'), path.join(ROOT, 'web')].filter((p) => fs.existsSync(p));
  const indexFile = (fs.existsSync(path.join(ROOT, 'dist', 'index.html')) ? path.join(ROOT, 'dist') : path.join(ROOT, 'web')) + '/index.html';

  const send = (res, status, data, headers = {}) => {
    const b = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC, ...headers });
    res.end(b);
  };
  const needAdmin = (req) => { if (!auth.valid(cookies(req).ws_admin)) throw Object.assign(new Error('Sign in to continue'), { status: 401 }); };

  function publicStats() {
    const sessions = store.get('sessions', []);
    const kept = sessions.filter((s) => s.status === 'completed' && !s.deletedAt).sort((a, b) => b.number - a.number);
    const latest = kept[0];
    const mem = memory.records().filter((r) => !r.retired);
    return {
      demo: settings.demo(), tatum: tatum.ready, walrus: memory.configured && memory.connected, memoryMode: memory.configured && memory.connected ? 'walrus' : 'local',
      sessions: kept.map((s) => s.number), latest: latest ? { number: latest.number, at: latest.finishedAt, rugs: latest.stats.rugs, survivors: latest.stats.survivors, patterns: latest.stats.patterns, auc: latest.metrics?.auc ?? null, byChain: latest.stats.byChain } : null,
      memories: { live: mem.length, walrus: mem.filter((m) => m.status === 'walrus').length }, scans: store.get('scans', []).length,
      running: learner.current ? { number: learner.current.number } : null,
    };
  }

  const routes = {
    'GET /api/health': () => ({ ok: true, time: Date.now() }),
    'GET /api/public/stats': () => publicStats(),
    'POST /api/scan': async (req, res, ip) => {
      if (limited(ip, 'scan', 10, 60000)) throw Object.assign(new Error('Too many scans. Wait a moment and try again.'), { status: 429 });
      const { input } = await body(req);
      const d = detectChain(input);
      if (!d.ok) throw Object.assign(new Error(d.hint), { status: 400 });
      return { id: startScan(ctx, d.chain, d.address).id, chain: d.chain, address: d.address };
    },
    'GET /api/admin/me': (req) => ({ authed: auth.valid(cookies(req).ws_admin), configured: auth.configured() }),
    'POST /api/admin/login': async (req, res, ip) => {
      if (limited(ip, 'login', 5, 300000)) throw Object.assign(new Error('Too many attempts. Try again in a few minutes.'), { status: 429 });
      const { password } = await body(req);
      if (!auth.configured() || !auth.login(String(password || ''))) throw Object.assign(new Error('Wrong password'), { status: 401 });
      return { ok: true, _cookie: auth.issue() };
    },
    'POST /api/admin/setup': async (req, res, ip) => {
      if (limited(ip, 'login', 5, 300000)) throw Object.assign(new Error('Too many attempts.'), { status: 429 });
      const { code, password } = await body(req);
      if (!auth.setup(String(code || ''), String(password || ''))) throw Object.assign(new Error('Setup code is wrong, or the password is shorter than 10 characters.'), { status: 400 });
      return { ok: true, _cookie: auth.issue() };
    },
    'POST /api/admin/logout': () => ({ ok: true, _cookie: '' }),
    'POST /api/admin/password': async (req) => {
      needAdmin(req);
      const { current, next } = await body(req);
      if (!auth.login(String(current || ''))) throw Object.assign(new Error('Current password is wrong'), { status: 401 });
      if (!auth.setPassword(String(next || ''))) throw Object.assign(new Error('Use at least 10 characters'), { status: 400 });
      return { ok: true };
    },
    'GET /api/admin/overview': (req) => {
      needAdmin(req);
      const sessions = store.get('sessions', []).map(({ log, ...s }) => s).sort((a, b) => a.number - b.number);
      const done = sessions.filter((s) => s.status === 'completed');
      const kept = done.filter((s) => !s.deletedAt);
      const latest = kept[kept.length - 1], prev = kept[kept.length - 2];
      const patterns = latest ? store.get('patterns', []).filter((p) => p.sid === latest.id).sort((a, b) => b.lift - a.lift).slice(0, 10) : [];
      const deployers = latest ? store.get('deployers', []).filter((d) => d.sid === latest.id).slice(0, 8) : [];
      const labelMix = latest ? { RUG: latest.stats.rugs, SURVIVOR: latest.stats.survivors } : null;
      const cur = learner.current;
      return { sessions, latest: latest || null, prev: prev || null, patterns, deployers, labelMix, current: cur ? { id: cur.id, number: cur.number, status: cur.status, stages: cur.stages, log: cur.log.slice(-40) } : null, stats: publicStats(), memoryError: memory.lastError };
    },
    'POST /api/admin/sessions/start': (req) => { needAdmin(req); const s = learner.start(); return { id: s.id, number: s.number }; },
    'POST /api/admin/sessions/cancel': (req) => { needAdmin(req); learner.cancel(); return { ok: true }; },
    'POST /api/admin/sessions/resume': async (req) => { needAdmin(req); const { id } = await body(req); const s = learner.start({ resumeId: id }); return { id: s.id }; },
    'POST /api/admin/sessions/delete': async (req) => {
      needAdmin(req); const { id } = await body(req);
      const s = store.get('sessions', []).find((x) => x.id === id);
      if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
      if (learner.current?.id === id) throw Object.assign(new Error('Cancel the running session first'), { status: 409 });
      purgeSession(store, memory, s);
      return { ok: true };
    },
    'GET /api/admin/live': (req) => { needAdmin(req); const c = learner.current || store.get('sessions', []).slice(-1)[0]; return c ? { id: c.id, number: c.number, status: c.status, stages: c.stages, log: c.log.slice(-60), error: c.error } : null; },
    'GET /api/admin/settings': (req) => { needAdmin(req); return { items: settings.list(), demo: settings.demo() }; },
    'PUT /api/admin/settings': async (req) => {
      needAdmin(req);
      const { set = {}, clear = [] } = await body(req);
      for (const [k, v] of Object.entries(set)) { if (typeof v === 'string' && !v.startsWith('••••')) settings.set(k, v); }
      for (const k of clear) settings.set(k, '');
      memory.resetClients();
      memory.health().catch(() => {});
      return { items: settings.list(), demo: settings.demo() };
    },
    'POST /api/admin/settings/test': async (req) => {
      needAdmin(req);
      const { target } = await body(req);
      try {
        if (target === 'tatum') return await tatum.ping();
        if (target === 'memory') return await memory.selfTest();
        if (target === 'dexscreener') { const p = await pairsFor('So11111111111111111111111111111111111111112'); return { ok: p.length > 0, detail: `${p.length} pairs for wSOL` }; }
        if (target === 'ai') { const r = await askJson(settings, 'Reply with {"ok":true}', { ping: 1 }, { maxTokens: 20 }); return { ok: !!r, detail: r ? 'Model replied' : 'No key set' }; }
        if (target === 'sniffer') { const r = await sniffScore(settings, 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'); return { ok: r.available, detail: r.available ? `${r.provider} score ${r.score}` : r.reason }; }
      } catch (e) { return { ok: false, detail: String(e.message).slice(0, 200) }; }
      return { ok: false, detail: 'Unknown target' };
    },
    'POST /api/admin/memory/recall': async (req) => {
      needAdmin(req);
      const { query } = await body(req);
      const nums = store.get('sessions', []).filter((s) => s.status === 'completed' && !s.deletedAt).map((s) => s.number);
      const r = await memory.recall(nums, String(query || '').slice(0, 300), 10);
      return { mode: r.mode, results: r.results.map((m) => ({ type: m.type, session: m.session, chain: m.chain, text: m.sentence, source: m.source, key: m.key })) };
    },
  };

  return http.createServer(async (req, res) => {
    const ip = ipOf(req);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-walsniff'] !== '1') throw Object.assign(new Error('Missing request header'), { status: 403 });
        let handler = routes[`${req.method} ${url.pathname}`];
        let params = {};
        const m = /^\/api\/scan\/([\w-]+)$/.exec(url.pathname);
        if (m && req.method === 'GET') { const j = getJob(m[1]); if (!j) throw Object.assign(new Error('Scan expired. Run it again.'), { status: 404 }); return send(res, 200, { id: j.id, status: j.status, stages: j.stages, error: j.error, result: j.result }); }
        const dbm = /^\/api\/admin\/db\/(\w+)$/.exec(url.pathname);
        if (dbm && req.method === 'GET') {
          needAdmin(req);
          const name = dbm[1];
          if (!['sessions', 'tokens', 'patterns', 'deployers', 'memory', 'scans', 'rulesets'].includes(name)) throw Object.assign(new Error('Unknown table'), { status: 404 });
          let rows = store.get(name, []);
          const q = (url.searchParams.get('q') || '').toLowerCase(), page = Math.max(0, Number(url.searchParams.get('page')) || 0), sid = url.searchParams.get('sid');
          if (sid) rows = rows.filter((r) => r.sid === sid);
          if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
          rows = [...rows].reverse();
          const slim = rows.slice(page * 25, page * 25 + 25).map((r) => { const { log, ev, ...rest } = r; return rest; });
          return send(res, 200, { total: rows.length, page, rows: slim });
        }
        if (!handler) throw Object.assign(new Error('Not found'), { status: 404 });
        const out = await handler(req, res, ip);
        const headers = {};
        if ('_cookie' in (out || {})) {
          const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
          headers['set-cookie'] = out._cookie ? `ws_admin=${encodeURIComponent(out._cookie)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}` : 'ws_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
          delete out._cookie;
        }
        return send(res, 200, out, headers);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
      let rel = decodeURIComponent(url.pathname);
      if (rel.includes('\0')) throw Object.assign(new Error('Bad path'), { status: 400 });
      let file = null;
      for (const root of staticRoots) {
        const p = path.normalize(path.join(root, rel));
        if (p.startsWith(root) && fs.existsSync(p) && fs.statSync(p).isFile()) { file = p; break; }
      }
      const isAsset = !!file && !file.endsWith('index.html');
      if (!file) file = indexFile;
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': isAsset && /\.(png|woff2|svg)$/.test(ext) ? 'public, max-age=86400' : 'no-cache', ...SEC });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[server]', e);
      send(res, status, { error: status >= 500 ? 'Something went wrong on our side. Try again.' : e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = buildApp();
  const server = createServer(ctx);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WalSniff] listening on :${PORT} ${ctx.settings.demo() ? '(demo mode: no Tatum key set)' : '(live mode)'}`);
    if (ctx.memory.configured) ctx.memory.health().then((h) => console.log(`[WalSniff] Walrus Memory: ${h.ok ? 'connected' : 'NOT connected - ' + h.detail}`));
    else console.log('[WalSniff] Walrus Memory: not configured, using the local mirror');
  });
  const stop = () => { ctx.store.flush(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
}
