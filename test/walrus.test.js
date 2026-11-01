import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/lib/store.js';
import { Settings } from '../server/lib/settings.js';
import { Memory, normalizeKey } from '../server/lib/adapters/memory.js';
import { parsePool } from '../server/lib/adapters/geckoterminal.js';
import { allocateQuota } from '../server/lib/learner.js';

const KEY = 'ab'.repeat(32);
function setup(sdkImpl) {
  const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-'))); const s = new Settings(st, 'k');
  s.set('MEMWAL_PRIVATE_KEY', '0x' + KEY); s.set('MEMWAL_ACCOUNT_ID', '0xacc'); s.set('MEMWAL_SERVER_URL', 'https://relayer.example/');
  return { st, s, mem: new Memory(s, st, { sdk: sdkImpl }) };
}
function fakeSdk(opts = {}) {
  const calls = { create: null, remember: [], wait: [], recall: [] };
  class MemWal {
    static create(o) { calls.create = o; return new MemWal(); }
    async remember(text, ns, o) { calls.remember.push({ text, ns, o }); if (opts.rememberErr) throw opts.rememberErr(); return { job_id: 'job' + calls.remember.length }; }
    async waitForRememberJob(id, o) { calls.wait.push({ id, o }); if (opts.waitErr) throw opts.waitErr(); return { status: 'done' }; }
    async recall(o) { calls.recall.push(o); return { results: opts.results || [] }; }
    async health() { if (opts.healthErr) throw opts.healthErr(); return { status: 'ok' }; }
  }
  return { sdk: { MemWal }, calls };
}

test('normalizeKey accepts 0x hex and explains bad keys', () => {
  assert.equal(normalizeKey('0x' + KEY.toUpperCase()), KEY);
  assert.throws(() => normalizeKey('suiprivkey1abc'), /suiprivkey/);
  assert.throws(() => normalizeKey('abc'), /64 hex/);
});

test('MemWal runtime SDK and Sui/Seal peer dependencies resolve', async () => {
  const [{ MemWal }, seal, sui] = await Promise.all([
    import('@mysten-incubation/memwal'),
    import('@mysten/seal'),
    import('@mysten/sui/grpc'),
  ]);
  assert.equal(typeof MemWal.create, 'function');
  assert.equal(typeof seal.SealClient, 'function');
  assert.equal(typeof sui.SuiGrpcClient, 'function');
});

test('writes use the real SDK shape and are confirmed', async () => {
  const { sdk, calls } = fakeSdk(); const { mem } = setup(sdk);
  const rec = await mem.remember({ sid: 's1', number: 4, type: 'PATTERN', chain: 'sui', sentence: 'x', key: { a: 1 } });
  assert.equal(rec.status, 'walrus');
  assert.equal(calls.create.key, KEY); assert.equal(calls.create.serverUrl, 'https://relayer.example'); assert.equal(calls.create.accountId, '0xacc');
  assert.equal(calls.remember[0].ns, 'walsniff-s4'); assert.ok(calls.remember[0].o.idempotencyKey);
  assert.equal(calls.wait[0].id, 'job1');
  assert.equal(mem.connected, true);
  const again = await mem.remember({ sid: 's1', number: 4, type: 'PATTERN', chain: 'sui', sentence: 'x', key: { a: 1 } });
  assert.equal(again.id, rec.id); assert.equal(calls.remember.length, 1, 'confirmed writes are not repeated');
});

test('timeouts become pending, hard failures become failed with the reason', async () => {
  const t = fakeSdk({ waitErr: () => Object.assign(new Error('timed out'), { name: 'MemWalRememberJobTimeoutError' }) });
  const a = setup(t.sdk); const r1 = await a.mem.remember({ sid: 's', number: 1, type: 'T', sentence: 'a' }); assert.equal(r1.status, 'pending');
  const f = fakeSdk({ rememberErr: () => new Error('invalid signature') });
  const b = setup(f.sdk); const r2 = await b.mem.remember({ sid: 's', number: 1, type: 'T', sentence: 'a' }); assert.equal(r2.status, 'failed'); assert.match(b.mem.lastError, /invalid signature/); assert.equal(b.mem.connected, false);
});

test('recall reads from Walrus and falls back to the local mirror', async () => {
  const text = '[WalSniff:PATTERN] s2 sui Mintable supply. ::{"id":"mintable@sui","sig":["mintable"],"chain":"sui","lift":3}';
  const { sdk, calls } = fakeSdk({ results: [{ text, distance: 0.1 }] }); const { mem } = setup(sdk);
  const r = await mem.recall([2], 'mintable', 5);
  assert.equal(r.mode, 'walrus'); assert.equal(r.results[0].key.lift, 3); assert.equal(calls.recall[0].namespace, 'walsniff-s2'); assert.equal(calls.recall[0].limit, 5);
  const bad = fakeSdk({ healthErr: null }); bad.sdk.MemWal.prototype.recall = async () => { throw new Error('relayer down'); };
  const m2 = setup(bad.sdk).mem; m2.records().push({ namespace: 'walsniff-s2', text, retired: false, status: 'local' });
  const r2 = await m2.recall([2], 'mintable supply', 5); assert.equal(r2.mode, 'local'); assert.equal(r2.results.length, 1);
});

test('self test requires a confirmed write; missing SDK gives an actionable message', async () => {
  const { sdk } = fakeSdk(); const { mem } = setup(sdk);
  const ok = await mem.selfTest(); assert.equal(ok.ok, true); assert.match(ok.detail, /confirmed/);
  const bad = setup(fakeSdk({ healthErr: () => new Error('401 unauthorized') }).sdk).mem; const r = await bad.selfTest(); assert.equal(r.ok, false); assert.match(r.detail, /401/);
  const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-'))); const s = new Settings(st, 'k');
  s.set('MEMWAL_PRIVATE_KEY', KEY); s.set('MEMWAL_ACCOUNT_ID', 'a'); s.set('MEMWAL_SERVER_URL', 'https://r.example');
  const m = new Memory(s, st); m.sdk = async () => { throw new Error('The Walrus Memory SDK is not installed. Run "npm install" in the Shell, then restart the app.'); };
  assert.match((await m.health()).detail, /npm install/);
});

test('GeckoTerminal pools parse tokens and skip majors', () => {
  const row = { attributes: { address: 'pool1', pool_created_at: '2026-10-27T10:00:00Z', reserve_in_usd: '1234.5' }, relationships: { base_token: { data: { id: 'sui-network_0xabc::meme::MEME' } }, quote_token: { data: { id: 'sui-network_0x2::sui::SUI' } } } };
  const p = parsePool('sui', row);
  assert.equal(p.length, 1); assert.equal(p[0].address, '0xabc::meme::MEME'); assert.equal(p[0].liquidityUsd, 1234.5); assert.ok(p[0].createdAt > 0);
  const rev = parsePool('solana', { attributes: {}, relationships: { base_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } }, quote_token: { data: { id: 'solana_NewMintAddr1111111111111111111111111111111' } } } });
  assert.deepEqual(rev.map((x) => x.address), ['NewMintAddr1111111111111111111111111111111']);
});

test('chain quotas add up and favour Sui', () => {
  const q = allocateQuota('sui:50,solana:30,ethereum:20', ['sui', 'solana', 'ethereum'], 300);
  assert.deepEqual(q, { sui: 150, solana: 90, ethereum: 60 });
  const odd = allocateQuota('', ['sui', 'solana'], 101); assert.equal(odd.sui + odd.solana, 101);
});
