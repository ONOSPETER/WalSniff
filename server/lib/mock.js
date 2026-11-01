// Deterministic demo data so the whole product works (and demos well) without any API keys.
// Everything produced here is flagged demo:true and shown as "Demo data" in the UI.
import crypto from 'node:crypto';

export function rng(seed) {
  let s = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const SYL = ['wal', 'tide', 'moss', 'kelp', 'tusk', 'brine', 'floe', 'pup', 'mochi', 'sui', 'rex', 'zap', 'nova', 'pepe', 'doge', 'moon', 'ape', 'fin', 'ice', 'lunar'];
const DEPLOYERS = Array.from({ length: 6 }, (_, i) => crypto.createHash('sha256').update('dep' + i).digest('hex').slice(0, 40));
const TEMPLATES = ['tpl_a1f09c', 'tpl_77b3e2', 'tpl_c04d18'];

export function mockEvidence(chain, address, forced) {
  const r = rng(chain + address);
  const rug = forced === 'RUG' ? true : forced === 'SURVIVOR' ? false : r() < 0.5;
  const bad = rug ? r() > 0.18 : r() < 0.14; // some rugs look clean, some survivors look shady
  const p = (a, b) => r() < (bad ? a : b);
  const name = SYL[Math.floor(r() * SYL.length)] + SYL[Math.floor(r() * SYL.length)];
  const ageHours = rug ? 2 + r() * 40 : 20 + r() * 400;
  const liq = rug ? r() * 1800 : 20000 + r() * 400000;
  const deployerRepeat = (bad && r() < 0.45) || (!rug && r() < 0.03);
  const dep = deployerRepeat ? DEPLOYERS[Math.floor(r() * DEPLOYERS.length)] : crypto.createHash('sha256').update(address + 'd').digest('hex').slice(0, 40);
  const contract = chain === 'solana'
    ? { kind: 'solana', mintable: p(0.7, 0.12), freezeAuthority: p(0.5, 0.1), permanentDelegate: p(0.1, 0.01), transferFee: p(0.1, 0.03), codeHash: null }
    : chain === 'sui'
      ? { kind: 'sui', mintable: p(0.65, 0.1), denyCap: p(0.3, 0.1), metadataFrozen: p(0.2, 0.7), upgradeable: null, codeHash: rug && r() < 0.6 ? TEMPLATES[Math.floor(r() * 3)] : crypto.createHash('sha256').update(address).digest('hex').slice(0, 16) }
      : { kind: 'evm', mintable: p(0.5, 0.1), blacklist: p(0.55, 0.12), taxSetters: p(0.55, 0.15), tradingSwitch: p(0.5, 0.15), limitSetters: p(0.4, 0.2), selfdestruct: p(0.12, 0.01), delegatecall: p(0.2, 0.1), proxy: p(0.2, 0.1), upgradeable: p(0.2, 0.1), ownerActive: p(0.8, 0.4), verified: !p(0.6, 0.12), codeHash: rug && r() < 0.6 ? TEMPLATES[Math.floor(r() * 3)] : crypto.createHash('sha256').update(address).digest('hex').slice(0, 16) };
  const hasSocial = !p(0.6, 0.1);
  return {
    demo: true, chain, address, demoKind: rug ? 'RUG' : 'SURVIVOR',
    market: { found: true, liquidityUsd: liq, volume24: liq * (rug ? 15 + r() * 60 : 0.2 + r() * 3), priceUsd: r() * 0.01, priceChange24: rug ? -(70 + r() * 29) : -20 + r() * 60, buys24: Math.floor(40 + r() * 600), sells24: Math.floor((rug ? 120 : 30) + r() * (rug ? 900 : 500)), ageHours, fdv: liq * 20, pairUrl: '#', dex: 'demo-dex', pairs: 1 },
    token: { name: name[0].toUpperCase() + name.slice(1), symbol: name.slice(0, 4).toUpperCase(), imageUrl: null, websites: hasSocial ? [{ label: 'Website', url: 'https://example.com' }] : [], socials: hasSocial ? [{ type: 'twitter', url: 'https://x.com/example' }] : [] },
    contract, holders: chain === 'solana' ? { topPct: rug ? 25 + r() * 45 : 4 + r() * 18, top10Pct: rug ? 55 + r() * 40 : 18 + r() * 30 } : null,
    deployer: { address: dep, ageDays: p(0.7, 0.2) ? r() * 2.5 : 5 + r() * 400, prevTokens: deployerRepeat ? 3 + Math.floor(r() * 6) : Math.floor(r() * 2), sharePct: chain === 'ethereum' ? (rug ? r() * 40 : r() * 6) : undefined },
    sniffer: chain === 'sui' ? { available: false, provider: null, reason: 'No sniffer service covers Sui yet' } : { available: true, provider: chain === 'solana' ? 'SolSniffer' : 'TokenSniffer', score: Math.round(rug ? 5 + r() * 55 : 60 + r() * 40) },
    gaps: [], sources: ['demo'],
  };
}

export function mockCandidates(chains, limit, seed) {
  const out = [];
  const per = Math.ceil(limit / chains.length);
  for (const c of chains) for (let i = 0; i < per && out.length < limit; i++) {
    const a = crypto.createHash('sha256').update(`${seed}:${c}:${i}`).digest('hex');
    const address = c === 'sui' ? `0x${a.slice(0, 40)}::${SYL[i % 20]}::${SYL[i % 20].toUpperCase()}` : c === 'solana' ? a.slice(0, 44).replace(/[0OIl]/g, 'A') : `0x${a.slice(0, 40)}`;
    out.push({ chain: c, address });
  }
  return out;
}
