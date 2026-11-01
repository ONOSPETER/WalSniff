import { http, cached } from '../net.js';
const BASE = 'https://api.dexscreener.com';
const get = (p, ttl = 20000) => cached('dx:' + p, ttl, () => http(BASE + p, { minGapMs: 220, timeout: 9000 }));

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
export function compactPair(p) {
  return {
    chainId: p.chainId, dex: p.dexId, url: p.url, pairAddress: p.pairAddress,
    base: { address: p.baseToken?.address, name: p.baseToken?.name, symbol: p.baseToken?.symbol },
    quote: { symbol: p.quoteToken?.symbol },
    priceUsd: num(p.priceUsd), liquidityUsd: num(p.liquidity?.usd), fdv: num(p.fdv), marketCap: num(p.marketCap),
    volume: p.volume || {}, txns: p.txns || {}, priceChange: p.priceChange || {}, createdAt: p.pairCreatedAt || null,
    info: p.info ? { imageUrl: p.info.imageUrl, header: p.info.header, websites: p.info.websites || [], socials: p.info.socials || [] } : null,
    boosts: p.boosts?.active || 0,
  };
}
// All pairs for a token address, best (most liquid) first.
export async function pairsFor(address) {
  const d = await get(`/latest/dex/tokens/${encodeURIComponent(address)}`);
  const pairs = (d?.pairs || []).map(compactPair).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return pairs;
}
export async function pairsByChain(chainId, addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const d = await get(`/tokens/v1/${chainId}/${addresses.slice(i, i + 30).map(encodeURIComponent).join(',')}`, 15000);
    out.push(...(Array.isArray(d) ? d : d?.pairs || []).map(compactPair));
  }
  return out;
}
// Candidate discovery: latest token profiles and boosts (note: skews to projects that paid for a profile).
export async function discover() {
  const [profiles, boosts] = await Promise.allSettled([get('/token-profiles/latest/v1', 30000), get('/token-boosts/latest/v1', 30000)]);
  const rows = [];
  for (const r of [profiles, boosts]) if (r.status === 'fulfilled' && Array.isArray(r.value)) rows.push(...r.value);
  const seen = new Set();
  return rows.filter((r) => r.chainId && r.tokenAddress && !seen.has(r.chainId + r.tokenAddress) && seen.add(r.chainId + r.tokenAddress))
    .map((r) => ({ chain: r.chainId, address: r.tokenAddress }));
}
