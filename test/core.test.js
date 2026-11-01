import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256, selector } from '../server/lib/keccak.js';
import { detectChain } from '../server/lib/chain.js';
import { scanBytecode } from '../server/lib/contract.js';
import { deriveFlags, scoreEvidence, DEFAULT_RULESET, fitRuleset, evalRuleset, auc, grade } from '../server/lib/model.js';
import { mockEvidence, rng } from '../server/lib/mock.js';
import { Store } from '../server/lib/store.js';
import { Settings } from '../server/lib/settings.js';
import { sign, verify, hashPassword, checkPassword } from '../server/lib/auth.js';
import { buildApp, createServer } from '../server/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));

test('keccak256 matches known vectors', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(selector('transfer(address,uint256)'), 'a9059cbb');
  assert.equal(selector('mint(address,uint256)'), '40c10f19');
});

test('chain detection', () => {
  assert.equal(detectChain('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48').chain, 'ethereum');
  assert.equal(detectChain('0x2::sui::SUI').chain, 'sui');
  assert.equal(detectChain('So11111111111111111111111111111111111111112').chain, 'solana');
  assert.equal(detectChain('0x' + 'a'.repeat(64)).ok, false);
  assert.equal(detectChain('hello').ok, false);
});

test('bytecode scan finds mint selector, selfdestruct, and skips push data', () => {
  // PUSH4 40c10f19 ... SELFDESTRUCT ; and a PUSH2 whose data contains 0xff must not count
  const withMint = '63' + '40c10f19' + 'ff';
  assert.equal(scanBytecode('0x' + withMint).mintable, true);
  assert.equal(scanBytecode('0x' + withMint).selfdestruct, true);
  assert.equal(scanBytecode('0x61ffff00').selfdestruct, false);
});

test('score is monotonic and bounded; memory adds risk', () => {
  const rug = deriveFlags(mockEvidence('ethereum', 'x', 'RUG'));
  const ok = deriveFlags(mockEvidence('ethereum', 'y', 'SURVIVOR'));
  const a = scoreEvidence(rug).risk, b = scoreEvidence(ok).risk;
  assert.ok(a >= 0 && a <= 100 && b >= 0 && b <= 100);
  assert.ok(scoreEvidence(rug, DEFAULT_RULESET, 1).risk > a);
  assert.equal(grade(5).key, 'low'); assert.equal(grade(95).key, 'critical');
});

test('fitted ruleset separates classes at least as well as priors on held-out data', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const label = i % 2 ? 'RUG' : 'SURVIVOR';
    const ev = mockEvidence(['sui', 'ethereum', 'solana'][i % 3], 'tok' + i, label);
    rows.push({ y: label === 'RUG' ? 1 : 0, x: Object.fromEntries(deriveFlags(ev).filter((f) => f.learn).map((f) => [f.id, f.sev])) });
  }
  const train = rows.filter((_, i) => i % 5), testRows = rows.filter((_, i) => !(i % 5));
  const fit = fitRuleset(train);
  const m = evalRuleset(testRows, fit), base = evalRuleset(testRows, DEFAULT_RULESET);
  assert.ok(m.auc > 0.8, `auc ${m.auc}`);
  assert.ok(m.auc >= base.auc - 0.02);
  assert.equal(auc([1, 2], [0, 1]), 1);
});

test('rng is deterministic', () => { assert.equal(rng('a')(), rng('a')()); });

test('settings encrypt secrets at rest and mask them', () => {
  const dir = tmp(); const st = new Store(dir); const s = new Settings(st, 'k');
  s.set('TATUM_API_KEY', 'secret-key-123456');
  assert.equal(s.get('TATUM_API_KEY'), 'secret-key-123456');
  assert.ok(!JSON.stringify(st.data).includes('secret-key-123456'));
  assert.equal(s.list().find((x) => x.key === 'TATUM_API_KEY').value, '••••3456');
  assert.equal(new Settings(st, 'other').get('TATUM_API_KEY'), '');
});

test('auth tokens expire and tamper-check; scrypt passwords verify', () => {
  assert.ok(verify('s', sign('s', 1000)));
  assert.ok(!verify('s', sign('s', -1)));
  const t = sign('s', 1000); assert.ok(!verify('s', t.slice(0, -2) + 'xx'));
  const rec = hashPassword('correct horse battery'); assert.ok(checkPassword('correct horse battery', rec)); assert.ok(!checkPassword('nope', rec));
});

async function waitFor(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); }

test('end to end: 3 demo sessions keep only X-1 and X; scan uses memory', async () => {
  const ctx = buildApp({ dataDir: tmp() });
  assert.ok(ctx.settings.demo());
  for (let i = 1; i <= 3; i++) {
    ctx.learner.start();
    await waitFor(() => !ctx.learner.current);
  }
  const sessions = ctx.store.get('sessions', []);
  assert.deepEqual(sessions.map((s) => s.status), ['completed', 'completed', 'completed']);
  assert.ok(sessions[0].deletedAt, 'session 1 purged');
  assert.ok(!sessions[1].deletedAt && !sessions[2].deletedAt);
  const tokens = ctx.store.get('tokens', []);
  assert.ok(!tokens.some((t) => t.sid === sessions[0].id));
  assert.ok(tokens.some((t) => t.sid === sessions[2].id));
  assert.ok(ctx.memory.records().filter((r) => r.sid === sessions[0].id).every((r) => r.retired));
  assert.ok(sessions[2].stats.memories.total >= 10);
  assert.ok(sessions[2].metrics.auc > 0.7);

  const server = createServer(ctx);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walsniff': '1', ...h }, body: JSON.stringify(b) });
  try {
    assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
    assert.equal((await post('/api/scan', { input: 'nope' })).status, 400);
    assert.equal((await fetch(base + '/api/scan', { method: 'POST', body: '{}' })).status, 403, 'CSRF header required');
    const started = await (await post('/api/scan', { input: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })).json();
    const done = await waitFor(async () => { const j = await (await fetch(`${base}/api/scan/${started.id}`)).json(); return j.status !== 'running' && j; });
    assert.equal(done.status, 'done');
    const r = done.result;
    assert.ok(r.score.final >= 0 && r.score.final <= 100);
    assert.ok(r.memory.sessions.length === 2 && r.memory.rulesetVersion === 3);
    assert.ok(r.verdict.headline);
    // admin flow
    ctx.auth.setPassword('a-long-test-password');
    const login = await post('/api/admin/login', { password: 'a-long-test-password' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const ov = await (await fetch(base + '/api/admin/overview', { headers: { cookie } })).json();
    assert.equal(ov.sessions.length, 3);
    const st = await (await fetch(base + '/api/admin/settings', { headers: { cookie } })).json();
    assert.ok(st.items.length > 10);
    assert.equal((await post('/api/admin/login', { password: 'wrong' })).status, 401);
  } finally { server.close(); }
});
