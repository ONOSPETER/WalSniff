import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.WS_NO_THROTTLE = '1';
const { buildApp } = await import('../server/index.js');

const now = Date.now();
const pool = (net, id, hoursAgo) => ({ attributes: { address: 'pool_' + id, pool_created_at: new Date(now - hoursAgo * 36e5).toISOString(), reserve_in_usd: '100' }, relationships: { base_token: { data: { id: `${net}_${id}` } }, quote_token: { data: { id: `${net}_0x2::sui::SUI` } } } });
const pair = (chainId, addr, { liq, h24, hoursAgo, tx = 80 }) => ({ chainId, dexId: 'd', url: 'u', pairAddress: 'p' + addr, baseToken: { address: addr, name: 'N', symbol: 'S' }, quoteToken: { symbol: 'Q' }, liquidity: { usd: liq }, priceChange: { h24 }, txns: { h24: { buys: tx / 2, sells: tx / 2 } }, pairCreatedAt: now - hoursAgo * 36e5 });

test('live discovery is multichain, Sui-weighted, and labels rugs vs survivors per chain', async () => {
  const ctx = buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'disc-')) });
  ctx.settings.set('DEMO_MODE', 'off'); ctx.settings.set('LEARN_LIMIT', '40');
  const suiNew = ['0xa::m::A', '0xb::m::B', '0xc::m::C', '0xd::m::D'];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url); const j = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (u.includes('geckoterminal') && u.includes('new_pools')) {
      if (!u.endsWith('page=1')) return j({ data: [] });
      if (u.includes('sui-network')) return j({ data: suiNew.map((t) => pool('sui-network', t, 5)) });
      if (u.includes('/solana/')) return j({ data: [pool('solana', 'SolRug1', 5), pool('solana', 'SolRug2', 5), pool('solana', 'SolRug3', 5)] });
      return j({ data: [] });
    }
    if (u.includes('trending_pools')) return j({ data: u.includes('sui-network') ? [pool('sui-network', '0xe::m::E', 90)] : u.includes('/solana/') ? [pool('solana', 'SolOk1', 90)] : [] });
    if (u.includes('token-profiles') || u.includes('token-boosts')) return j([]);
    if (u.includes('/tokens/v1/sui/')) return j([pair('sui', '0xa::m::A', { liq: 100, h24: -95, hoursAgo: 5 }), pair('sui', '0xb::m::B', { liq: 50, h24: -99, hoursAgo: 5 }), pair('sui', '0xc::m::C', { liq: 80, h24: -92, hoursAgo: 5 }), pair('sui', '0xd::m::D', { liq: 9000, h24: 5, hoursAgo: 8 }), pair('sui', '0xe::m::E', { liq: 90000, h24: 10, hoursAgo: 90 })]);
    if (u.includes('/tokens/v1/solana/')) return j([pair('solana', 'SolRug1', { liq: 10, h24: -97, hoursAgo: 5 }), pair('solana', 'SolRug2', { liq: 20, h24: -96, hoursAgo: 5 }), pair('solana', 'SolRug3', { liq: 30, h24: -99, hoursAgo: 5 }), pair('solana', 'SolOk1', { liq: 50000, h24: 3, hoursAgo: 90 })]);
    return j([]);
  };
  try {
    const l = ctx.learner;
    const s = { id: 'x', number: 1, demo: false, log: [], config: { windowHours: 48, limit: 40, chains: ['sui', 'solana', 'ethereum'] } };
    const w = {};
    await l.discover(s, w);
    l.label(s, w);
    const by = (c, lab) => w.tokens.filter((t) => t.chain === c && t.label === lab).length;
    assert.equal(by('sui', 'RUG'), 3); assert.ok(by('sui', 'SURVIVOR') >= 2, 'sui survivors include the new-but-healthy token and the control token');
    assert.equal(by('solana', 'RUG'), 3); assert.equal(by('solana', 'SURVIVOR'), 1);
    assert.ok(w.quotas.sui > w.quotas.solana && w.quotas.solana > w.quotas.ethereum);
  } finally { globalThis.fetch = oldFetch; }
});
