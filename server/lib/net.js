// Resilient HTTP: timeout, retry with jitter, per-host circuit breaker, min-interval throttle, TTL cache.
const breakers = new Map();
const lastCall = new Map();
const cache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class HttpError extends Error {
  constructor(msg, status, host) { super(msg); this.status = status; this.host = host; }
}

function breaker(host) {
  if (!breakers.has(host)) breakers.set(host, { fails: 0, openUntil: 0 });
  return breakers.get(host);
}

export async function http(url, { method = 'GET', headers = {}, body, timeout = 10000, retries = 2, minGapMs = 0, signal } = {}) {
  const host = new URL(url).host;
  if (process.env.WS_NO_THROTTLE) minGapMs = 0; // tests only
  const b = breaker(host);
  if (Date.now() < b.openUntil) throw new HttpError(`${host} is cooling down after repeated failures`, 503, host);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (minGapMs) {
      const wait = (lastCall.get(host) || 0) + minGapMs - Date.now();
      lastCall.set(host, Math.max(Date.now(), (lastCall.get(host) || 0) + minGapMs));
      if (wait > 0) await sleep(wait);
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method, signal: signal || ctl.signal,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      clearTimeout(t);
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        const err = new HttpError(`${host} responded ${res.status}${detail ? `: ${detail}` : ''}`, res.status, host);
        if (res.status === 429 || res.status >= 500) throw err;
        b.fails = 0; throw Object.assign(err, { final: true });
      }
      b.fails = 0;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      clearTimeout(t);
      lastErr = e.name === 'AbortError' ? new HttpError(`${host} timed out`, 408, host) : e;
      if (lastErr.final) throw lastErr;
      if (attempt < retries) await sleep(300 * 2 ** attempt + Math.random() * 200);
    }
  }
  b.fails++;
  if (b.fails >= 5) { b.openUntil = Date.now() + 30000; b.fails = 0; }
  throw lastErr;
}

export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  cache.set(key, { v, exp: Date.now() + ttlMs });
  if (cache.size > 2000) for (const [k, e] of cache) if (e.exp < Date.now()) cache.delete(k);
  return v;
}

// Run async tasks with limited concurrency; failures are captured, never thrown.
export async function pool(items, limit, worker, { onProgress, shouldStop } = {}) {
  let i = 0, done = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      if (shouldStop?.()) return;
      const idx = i++;
      try { out[idx] = { ok: true, value: await worker(items[idx], idx) }; }
      catch (e) { out[idx] = { ok: false, error: e.message }; }
      onProgress?.(++done, items.length);
    }
  }));
  return out;
}
export { sleep };
