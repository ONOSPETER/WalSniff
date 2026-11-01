// GeckoTerminal public API: newly created pools per network (free, ~30 requests/min). Used for token discovery
// because DexScreener has no "new pairs" endpoint and its profile feed skews towards Solana.
import { http, cached } from '../net.js';

const BASE = 'https://api.geckoterminal.com/api/v2';
export const NETWORK = { sui: 'sui-network', solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc' };
// Quote assets we never want to treat as "new tokens".
const MAJORS = new Set([
  '0x2::sui::sui', 'so11111111111111111111111111111111111111112', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f',
  'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v', 'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb',
]);
const isMajor = (a) => MAJORS.has(String(a).toLowerCase()) || /::(usdc|usdt|sui|wal)::/i.test(a);

export function parsePool(chain, row) {
  const net = NETWORK[chain];
  const a = row?.attributes || {};
  const toks = ['base_token', 'quote_token'].map((k) => row?.relationships?.[k]?.data?.id).filter(Boolean)
    .map((id) => (id.startsWith(net + '_') ? id.slice(net.length + 1) : null)).filter((x) => x && !isMajor(x));
  return toks.map((address) => ({ chain, address, pool: a.address, createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null, liquidityUsd: a.reserve_in_usd != null ? Number(a.reserve_in_usd) : null }));
}

async function pools(chain, path) {
  if (!NETWORK[chain]) return [];
  const url = `${BASE}/networks/${NETWORK[chain]}/${path}`;
  const d = await cached('gt:' + url, 60000, () => http(url, { headers: { accept: 'application/json;version=20230302' }, minGapMs: 2300, timeout: 12000 }));
  return (d?.data || []).flatMap((row) => parsePool(chain, row));
}

// Walks pages of new pools until they fall outside the window.
export async function newPools(chain, { pages = 6, cutoff = 0 } = {}) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const rows = await pools(chain, `new_pools?page=${p}`);
    all.push(...rows);
    if (!rows.length || rows.every((r) => r.createdAt && r.createdAt < cutoff)) break;
  }
  return all;
}
export const trendingPools = (chain) => pools(chain, 'trending_pools?page=1');
