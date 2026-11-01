// Walrus Memory (MemWal) client with a local mirror so WalSniff keeps working when Walrus is unreachable.
// SDK surface used (MemWal TypeScript SDK): MemWal.create({ key, accountId, serverUrl, namespace }),
// remember(text, namespace, { idempotencyKey }) -> { job_id }, waitForRememberJob(jobId, { timeoutMs }),
// recall({ query, namespace, limit }), health().
// Record text format: "[WalSniff:TYPE] s<session> <chain> <sentence> ::<json>"
import crypto from 'node:crypto';
import { sleep } from '../net.js';

const tok = (s) => String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
const WAIT_MS = 90000;

// The delegate key must be a 32-byte Ed25519 seed as hex. Fail early with a message that says how to fix it.
export function normalizeKey(raw) {
  const k = String(raw || '').trim().replace(/^0x/i, '');
  if (/^suiprivkey/i.test(k)) throw new Error('The key is in suiprivkey format. MemWal needs the 32-byte delegate key as 64 hex characters.');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error(`The MemWal key must be 64 hex characters (a 32-byte Ed25519 seed). Yours has ${k.length} characters.`);
  return k.toLowerCase();
}
const jobIdOf = (j) => j?.job_id ?? j?.jobId ?? j?.id ?? null;
const isRetryable = (e) => /RateLimited/i.test(e?.name || '') || /rate.?limit|429|ECONN|ETIMEDOUT|fetch failed|socket|503|502/i.test(String(e?.message || ''));

export class Memory {
  constructor(settings, store, { sdk } = {}) {
    this.s = settings; this.store = store; this._sdk = sdk || null;
    this.client = null; this.sig = ''; this.connected = false; this.lastError = null; this.lastCheck = null;
  }
  get configured() { return !!(this.s.get('MEMWAL_PRIVATE_KEY') && this.s.get('MEMWAL_ACCOUNT_ID') && this.s.get('MEMWAL_SERVER_URL')); }
  namespace(n) { return `${this.s.get('MEMWAL_NAMESPACE_PREFIX') || 'walsniff'}-s${n}`; }
  records() { return this.store.get('memory', []); }
  fail(e) { this.lastError = String(e?.message || e).slice(0, 220); this.connected = false; return this.lastError; }

  async sdk() {
    if (this._sdk) return this._sdk;
    try { this._sdk = await import('@mysten-incubation/memwal'); return this._sdk; }
    catch (e) { throw new Error('The Walrus Memory SDK is not installed. Run "npm install" in the Shell, then restart the app.'); }
  }
  async getClient() {
    const key = normalizeKey(this.s.get('MEMWAL_PRIVATE_KEY'));
    const accountId = this.s.get('MEMWAL_ACCOUNT_ID').trim();
    const serverUrl = this.s.get('MEMWAL_SERVER_URL').trim().replace(/\/+$/, '');
    const prefix = this.s.get('MEMWAL_NAMESPACE_PREFIX') || 'walsniff';
    const sig = [key, accountId, serverUrl, prefix].join('|');
    if (this.client && this.sig === sig) return this.client;
    const { MemWal } = await this.sdk();
    this.client = MemWal.create({ key, accountId, serverUrl, namespace: prefix });
    this.sig = sig;
    return this.client;
  }
  resetClients() { this.client = null; this.sig = ''; this.connected = false; }

  async retry(fn, tries = 4) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) { if (i >= tries - 1 || !isRetryable(e)) throw e; await sleep(1500 * 2 ** i); }
    }
  }

  // Send one record to Walrus. 'walrus' = job confirmed, 'pending' = accepted but not confirmed yet, 'failed' = rejected.
  async send(rec) {
    const c = await this.getClient();
    const idempotencyKey = crypto.createHash('sha256').update(rec.namespace + rec.text).digest('hex').slice(0, 48);
    const job = await this.retry(() => c.remember(rec.text, rec.namespace, { idempotencyKey }));
    rec.jobId = jobIdOf(job);
    if (!rec.jobId) { rec.status = 'pending'; return rec; }
    try {
      await c.waitForRememberJob(rec.jobId, { timeoutMs: WAIT_MS });
      rec.status = 'walrus'; rec.error = undefined; this.connected = true; this.lastError = null;
    } catch (e) {
      if (/Timeout/i.test(e?.name || '') || /timed? ?out/i.test(e?.message || '')) rec.status = 'pending';
      else { rec.status = 'failed'; rec.error = String(e.message || e).slice(0, 160); this.fail(e); }
    }
    return rec;
  }

  async remember({ sid, number, type, chain = 'any', sentence, key = {} }) {
    const ns = this.namespace(number);
    const text = `[WalSniff:${type}] s${number} ${chain} ${sentence} ::${JSON.stringify(key)}`;
    const dup = this.records().find((r) => r.namespace === ns && r.text === text && !r.retired);
    if (dup && dup.status === 'walrus') return dup;
    const rec = dup || { id: crypto.randomUUID(), sid, namespace: ns, type, chain, text, key, status: 'local', jobId: null, at: Date.now(), retired: false };
    if (!dup) this.records().push(rec);
    if (this.configured) {
      try { await this.send(rec); }
      catch (e) { rec.status = 'failed'; rec.error = this.fail(e); }
    }
    this.store.save();
    return rec;
  }

  // Give accepted-but-unconfirmed jobs one more chance to settle.
  async reconcile(sid) {
    if (!this.configured) return 0;
    let fixed = 0;
    for (const rec of this.records().filter((r) => r.sid === sid && r.status === 'pending' && r.jobId)) {
      try { const c = await this.getClient(); await c.waitForRememberJob(rec.jobId, { timeoutMs: 30000 }); rec.status = 'walrus'; fixed++; }
      catch (e) { if (!/Timeout/i.test(e?.name || '')) { rec.status = 'failed'; rec.error = String(e.message || e).slice(0, 160); } }
    }
    this.store.save();
    return fixed;
  }

  // Semantic recall from Walrus (when connected) with local keyword recall as a fallback.
  async recall(numbers, query, k = 8) {
    const out = [];
    let mode = 'none';
    for (const n of numbers) {
      const ns = this.namespace(n);
      if (this.configured) {
        try {
          const c = await this.getClient();
          const r = await this.retry(() => c.recall({ query, namespace: ns, limit: k }), 2);
          const items = r?.results || r?.memories || r?.items || (Array.isArray(r) ? r : []);
          for (const m of items) out.push({ text: m.text ?? m.content ?? m.memory ?? '', distance: m.distance ?? m.score, source: 'walrus', ns });
          mode = 'walrus';
          continue;
        } catch (e) { this.fail(e); }
      }
      const q = new Set(tok(query));
      const scored = this.records().filter((r) => r.namespace === ns && !r.retired).map((r) => {
        const t = tok(r.text); let hit = 0; for (const w of t) if (q.has(w)) hit++;
        return { r, s: hit / Math.sqrt(t.length || 1) };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
      for (const x of scored) out.push({ text: x.r.text, distance: 1 / (1 + x.s), source: 'local', ns });
      if (scored.length && mode === 'none') mode = 'local';
    }
    return { mode, results: out.map((m) => ({ ...m, ...parse(m.text) })).filter((m) => m.type) };
  }

  // Exact lookups against the local index (addresses and code hashes do not embed well).
  exact(numbers, type, field, value) {
    const ns = new Set(numbers.map((n) => this.namespace(n)));
    return this.records().filter((r) => !r.retired && r.type === type && ns.has(r.namespace) && String(r.key?.[field]).toLowerCase() === String(value).toLowerCase());
  }
  retireSession(number) {
    const ns = this.namespace(number);
    for (const r of this.records()) if (r.namespace === ns) r.retired = true;
    this.store.save();
  }

  async health() {
    this.lastCheck = Date.now();
    if (!this.configured) return { ok: false, detail: 'Not configured. Add the MemWal key, account ID and relayer URL in Settings. Memories stay in the local mirror until then.' };
    try { const c = await this.getClient(); await c.health(); this.connected = true; this.lastError = null; return { ok: true, detail: 'Relayer reachable' }; }
    catch (e) { return { ok: false, detail: this.fail(e) }; }
  }
  // Full check used by the Test button: health plus one real write that must be confirmed by the relayer.
  async selfTest() {
    const h = await this.health();
    if (!h.ok) return h;
    try {
      const rec = { namespace: `${this.s.get('MEMWAL_NAMESPACE_PREFIX') || 'walsniff'}-selftest`, text: `[WalSniff:SELFTEST] connection check ${new Date().toISOString()}` };
      await this.send(rec);
      return rec.status === 'walrus' ? { ok: true, detail: `Write confirmed on Walrus (job ${String(rec.jobId).slice(0, 10)})` } : { ok: false, detail: rec.status === 'pending' ? 'Write accepted but not confirmed within 90s. Try again.' : `Write failed: ${rec.error || this.lastError}` };
    } catch (e) { return { ok: false, detail: this.fail(e) }; }
  }
}
export function parse(text) {
  const m = /^\[WalSniff:(\w+)\] s(\d+) (\S+) (.*?) ::(\{[\s\S]*\})\s*$/.exec(text || '');
  if (!m) return {};
  try { return { type: m[1], session: Number(m[2]), chain: m[3], sentence: m[4], key: JSON.parse(m[5]) }; } catch { return {}; }
}
