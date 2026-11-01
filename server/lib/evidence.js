// Evidence collection shared by the scanner and the learner so features always match.
import crypto from 'node:crypto';
import { http } from './net.js';
import { pairsFor } from './adapters/dexscreener.js';
import { sniffScore } from './adapters/sniffers.js';
import { inspectEvm, inspectSui, inspectSolana } from './contract.js';
import { mockEvidence } from './mock.js';
import { EVM_CHAINS, isEvm } from './chain.js';

const hoursSince = (ms) => (ms ? (Date.now() - ms) / 36e5 : null);

export function marketFrom(pairs, chain) {
  const own = pairs.filter((p) => p.chainId === chain);
  const use = own.length ? own : pairs;
  if (!use.length) return { found: false };
  const best = use[0];
  const created = use.map((p) => p.createdAt).filter(Boolean);
  const sum = (f) => use.reduce((a, p) => a + (f(p) || 0), 0);
  return {
    found: true, chainId: best.chainId, dex: best.dex, pairUrl: best.url, pairs: use.length,
    liquidityUsd: sum((p) => p.liquidityUsd), volume24: sum((p) => p.volume?.h24),
    priceUsd: best.priceUsd, priceChange24: best.priceChange?.h24 ?? null, priceChange1h: best.priceChange?.h1 ?? null,
    buys24: best.txns?.h24?.buys ?? 0, sells24: best.txns?.h24?.sells ?? 0,
    fdv: best.fdv, marketCap: best.marketCap, ageHours: created.length ? hoursSince(Math.min(...created)) : null,
    createdAt: created.length ? Math.min(...created) : null,
  };
}
export function tokenFrom(pairs) {
  const p = pairs[0];
  if (!p) return {};
  return { name: p.base.name, symbol: p.base.symbol, imageUrl: p.info?.imageUrl || null, header: p.info?.header || null, websites: p.info?.websites || [], socials: p.info?.socials || [] };
}

async function deployerAge(ctx, chain, address) {
  const { tatum, settings } = ctx;
  if (chain === 'solana') {
    const sigs = await tatum.rpc('solana', 'getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1].blockTime;
    return sigs.length >= 1000 ? 365 : oldest ? (Date.now() / 1000 - oldest) / 86400 : null;
  }
  if (chain === 'sui') return null; // address history queries were part of the retired JSON-RPC API; wallet age needs an indexer
  const key = settings.get('ETHERSCAN_API_KEY');
  if (!key) return null;
  const id = EVM_CHAINS[chain].id;
  const r = await http(`https://api.etherscan.io/v2/api?chainid=${id}&module=account&action=txlist&address=${address}&page=1&offset=1&sort=asc&apikey=${key}`, { minGapMs: 250 });
  const t = r?.result?.[0]?.timeStamp;
  return t ? (Date.now() / 1000 - Number(t)) / 86400 : null;
}

export function knownTokensByDeployer(store, address, exceptToken) {
  const seen = new Set();
  for (const t of store.get('tokens', [])) if (t.deployer === address && t.address !== exceptToken) seen.add(t.address);
  for (const s of store.get('scans', [])) if (s.deployer === address && s.address !== exceptToken) seen.add(s.address);
  return seen.size;
}

export async function collectEvidence(ctx, chain, address, onStage = () => {}, { forced } = {}) {
  const { settings, tatum, store } = ctx;
  if (settings.demo()) {
    for (const s of ['market', 'contract', 'sniffer']) onStage(s, 'done');
    const ev = mockEvidence(chain, address, forced);
    if (ev.deployer?.address) ev.deployer.prevTokens = Math.max(ev.deployer.prevTokens || 0, knownTokensByDeployer(store, ev.deployer.address, address));
    return ev;
  }
  const ev = { demo: false, chain, address, market: { found: false }, token: {}, contract: null, holders: null, deployer: null, sniffer: null, gaps: [], sources: [] };
  const gap = (source, reason) => ev.gaps.push({ source, reason: String(reason).slice(0, 160) });
  const run = async (name, fn) => { onStage(name, 'running'); try { await fn(); onStage(name, 'done'); } catch (e) { gap(name, e.message); onStage(name, 'failed'); } };

  await run('market', async () => {
    const pairs = await pairsFor(address);
    ev.sources.push('dexscreener');
    if (!pairs.length) { gap('market', 'DexScreener has no pair for this token yet'); return; }
    if (isEvm(chain)) {
      const best = pairs[0].chainId;
      if (EVM_CHAINS[best]) ev.chain = best;
      else gap('contract', `The main pair is on ${best}, which WalSniff cannot inspect yet`);
    }
    ev.market = marketFrom(pairs, ev.chain);
    ev.token = tokenFrom(pairs.filter((p) => p.chainId === ev.chain).length ? pairs.filter((p) => p.chainId === ev.chain) : pairs);
  });

  const unsupported = ev.gaps.some((g) => g.source === 'contract');
  await Promise.all([
    run('contract', async () => {
      if (unsupported) return;
      if (!tatum.ready) throw new Error('Tatum API key is not set');
      let r;
      if (ev.chain === 'sui') r = await inspectSui(tatum, address);
      else if (ev.chain === 'solana') r = await inspectSolana(tatum, address);
      else r = await inspectEvm(tatum, ev.chain, address, { etherscanKey: settings.get('ETHERSCAN_API_KEY'), http });
      ev.contract = r.contract; ev.holders = r.holders || null; ev.deployer = r.deployer || null;
      ev.sources.push('tatum-rpc');
      if (r.contract?.meta && !ev.token.name) ev.token = { ...ev.token, name: r.contract.meta.name, symbol: r.contract.meta.symbol, imageUrl: ev.token.imageUrl || r.contract.meta.iconUrl, description: r.contract.meta.description };
    }),
    run('sniffer', async () => { ev.sniffer = await sniffScore(settings, ev.chain, address); if (ev.sniffer.available) ev.sources.push(ev.sniffer.provider.toLowerCase()); else gap('sniffer', ev.sniffer.reason); }),
    run('security', async () => { const s = await tatum.security(ev.chain, address); if (s) { ev.securityRaw = JSON.stringify(s).slice(0, 1500); ev.sources.push('tatum-security'); } }),
  ]);

  if (ev.deployer?.address) {
    await run('deployer', async () => {
      const d = ev.deployer;
      const [age, share] = await Promise.allSettled([
        deployerAge(ctx, ev.chain, d.address),
        isEvm(ev.chain) && ev.contract?.totalSupplyRaw ? tatum.rpc(ev.chain, 'eth_call', [{ to: address, data: '0x70a08231' + d.address.slice(2).padStart(64, '0') }, 'latest']) : Promise.resolve(null),
      ]);
      if (age.value !== undefined && age.value !== null) d.ageDays = age.value;
      if (share.value && share.value !== '0x') d.sharePct = Number((BigInt(share.value) * 10000n) / BigInt(ev.contract.totalSupplyRaw)) / 100;
      d.prevTokens = knownTokensByDeployer(store, d.address, address);
    });
  } else if (ev.contract) gap('deployer', 'Deployer could not be identified');
  if (ev.chain !== 'solana' && !ev.holders) gap('holders', 'Holder distribution needs an indexer; only Solana exposes it over RPC');
  return ev;
}
export const hashFrac = (s) => crypto.createHash('sha1').update(String(s)).digest().readUInt16BE(0) / 65535;
