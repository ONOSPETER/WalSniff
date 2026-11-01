// Chain-specific contract inspection through Tatum RPC. Every function returns a normalised `contract` object
// (+ holders / deployer where the chain allows) and throws on hard failure; callers record the failure as an evidence gap.
import crypto from 'node:crypto';
import { selector } from './keccak.js';
import { analyzePackage, isImmutableOwner } from './adapters/suigrpc.js';

const SIGS = {
  mintable: ['mint(address,uint256)', 'mint(uint256)', 'mint(address)', 'ownerMint(address,uint256)', 'mintTo(address,uint256)'],
  blacklist: ['blacklist(address)', 'blacklistAddress(address,bool)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'addBot(address)', 'setBots(address[])', 'blockAddress(address)', 'updateBlacklist(address,bool)'],
  taxSetters: ['setTaxFee(uint256)', 'setFees(uint256,uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'updateFees(uint256,uint256)', 'setTax(uint256)', 'setSellTax(uint256)', 'setBuyTax(uint256)', 'setTaxes(uint256,uint256)'],
  tradingSwitch: ['enableTrading()', 'setTradingEnabled(bool)', 'openTrading()', 'startTrading()', 'setTrading(bool)', 'setSwapEnabled(bool)'],
  limitSetters: ['setMaxTxAmount(uint256)', 'setMaxWalletSize(uint256)', 'removeLimits()', 'setMaxWallet(uint256)', 'setMaxTransactionAmount(uint256)', 'updateMaxTxAmount(uint256)'],
  pausable: ['pause()', 'unpause()'],
};
const SEL = Object.fromEntries(Object.entries(SIGS).map(([k, v]) => [k, new Set(v.map(selector))]));
const OWNER = '8da5cb5b', EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const hash = (arr) => crypto.createHash('sha256').update([...arr].sort().join(',')).digest('hex').slice(0, 16);
const hex64ToAddr = (h) => (h && h.length >= 42 ? '0x' + h.slice(-40) : null);
const ZERO = /^0x0{40}$/;

export function scanBytecode(code) {
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  const b = Buffer.from(hex, 'hex');
  const selectors = new Set();
  let selfdestruct = false, delegatecall = false;
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63 && i + 4 < b.length) selectors.add(b.subarray(i + 1, i + 5).toString('hex'));
    if (op >= 0x60 && op <= 0x7f) { i += op - 0x5f; continue; }
    if (op === 0xff) selfdestruct = true;
    if (op === 0xf4) delegatecall = true;
  }
  const has = (k) => [...selectors].some((s) => SEL[k].has(s));
  const minimalProxy = hex.startsWith('363d3d373d3d3d363d73');
  return {
    size: b.length, selectors: [...selectors], selfdestruct, delegatecall, minimalProxy,
    mintable: has('mintable'), blacklist: has('blacklist'), taxSetters: has('taxSetters'),
    tradingSwitch: has('tradingSwitch'), limitSetters: has('limitSetters'), pausable: has('pausable'),
  };
}

export async function inspectEvm(tatum, chain, address, { etherscanKey, http } = {}) {
  const code = await tatum.rpc(chain, 'eth_getCode', [address, 'latest']);
  if (!code || code === '0x') throw new Error('No contract code at this address on ' + chain);
  const s = scanBytecode(code);
  const call = (data) => tatum.rpc(chain, 'eth_call', [{ to: address, data }, 'latest']).catch(() => null);
  const [owner, slot, supply] = await Promise.all([call('0x' + OWNER), tatum.rpc(chain, 'eth_getStorageAt', [address, EIP1967, 'latest']).catch(() => null), call('0x18160ddd')]);
  const hasOwnerFn = s.selectors.includes(OWNER);
  const ownerAddr = hasOwnerFn ? hex64ToAddr(owner) : null;
  const contract = {
    kind: 'evm', codeSize: s.size, codeHash: hash(s.selectors), selectors: s.selectors.length,
    mintable: s.mintable, blacklist: s.blacklist, taxSetters: s.taxSetters, tradingSwitch: s.tradingSwitch, limitSetters: s.limitSetters,
    pausable: s.pausable, selfdestruct: s.selfdestruct, delegatecall: s.delegatecall,
    proxy: s.minimalProxy || (slot && !/^0x0*$/.test(slot)) || false,
    upgradeable: slot ? !/^0x0*$/.test(slot) : null,
    ownerActive: ownerAddr ? !ZERO.test(ownerAddr) : null, owner: ownerAddr,
    totalSupplyRaw: supply && supply !== '0x' ? BigInt(supply).toString() : null,
  };
  let deployer = null, verified = null;
  if (etherscanKey && http) {
    const id = chain === 'ethereum' ? 1 : chain === 'base' ? 8453 : 56;
    const [cc, src] = await Promise.allSettled([
      http(`https://api.etherscan.io/v2/api?chainid=${id}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${etherscanKey}`, { minGapMs: 250 }),
      http(`https://api.etherscan.io/v2/api?chainid=${id}&module=contract&action=getsourcecode&address=${address}&apikey=${etherscanKey}`, { minGapMs: 250 }),
    ]);
    const creator = cc.value?.result?.[0]?.contractCreator;
    if (creator) deployer = { address: creator.toLowerCase() };
    const r = src.value?.result?.[0];
    if (r) verified = !!r.SourceCode;
  }
  contract.verified = verified;
  return { contract, deployer };
}

export async function inspectSui(tatum, coinType) {
  const sui = await tatum.sui(); // SuiReader over Tatum's gRPC gateway
  const pkgId = coinType.split('::')[0];
  const [info, pkg] = await Promise.all([sui.coinInfo(coinType).catch(() => null), sui.packageInfo(pkgId)]);
  const { treasuryExposed, denyCap, fnNames } = analyzePackage(pkg);
  const meta = info?.metadata ?? null;
  let metadataFrozen = null, deployer = null;
  if (meta?.id) {
    const o = await sui.objectInfo(meta.id).catch(() => null);
    metadataFrozen = o ? isImmutableOwner(o.owner) : null;
  }
  try {
    const o = await sui.objectInfo(pkgId);
    const sender = o?.previousTransaction ? await sui.sender(o.previousTransaction) : null;
    if (sender) deployer = { address: sender.toLowerCase() };
  } catch { /* deployer stays unknown */ }
  const contract = {
    kind: 'sui', codeSize: fnNames.length, codeHash: fnNames.length ? hash(fnNames.map((n) => n.split('::')[1])) : null, selectors: fnNames.length,
    mintable: treasuryExposed, denyCap: denyCap || !!info?.regulated, metadataFrozen, upgradeable: null,
    totalSupplyRaw: info?.supply ?? null, decimals: meta?.decimals ?? null,
    meta: meta ? { name: meta.name, symbol: meta.symbol, description: meta.description, iconUrl: meta.iconUrl } : null,
  };
  return { contract, deployer };
}

export async function inspectSolana(tatum, mint) {
  const acc = await tatum.rpc('solana', 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const info = acc?.value?.data?.parsed?.info;
  if (!info) throw new Error('Not an SPL token mint');
  const ext = (info.extensions || []).map((e) => e.extension);
  const contract = {
    kind: 'solana', mintable: !!info.mintAuthority, mintAuthority: info.mintAuthority || null,
    freezeAuthority: !!info.freezeAuthority, permanentDelegate: ext.includes('permanentDelegate'),
    transferFee: ext.includes('transferFeeConfig'), token2022: acc.value.owner?.startsWith('TokenzQd') || false,
    decimals: info.decimals, totalSupplyRaw: info.supply, codeHash: null, upgradeable: null,
  };
  let holders = null, deployer = null;
  try {
    const big = await tatum.rpc('solana', 'getTokenLargestAccounts', [mint]);
    const amts = (big?.value || []).map((v) => Number(v.uiAmount || 0));
    const supply = Number(info.supply) / 10 ** info.decimals;
    if (supply > 0 && amts.length) holders = { topPct: (amts[0] / supply) * 100, top10Pct: (amts.slice(0, 10).reduce((a, b) => a + b, 0) / supply) * 100 };
  } catch { /* holders unavailable */ }
  try {
    const sigs = await tatum.rpc('solana', 'getSignaturesForAddress', [mint, { limit: 1000 }]);
    if (sigs?.length && sigs.length < 1000) {
      const tx = await tatum.rpc('solana', 'getTransaction', [sigs[sigs.length - 1].signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const payer = tx?.transaction?.message?.accountKeys?.[0];
      const a = typeof payer === 'string' ? payer : payer?.pubkey;
      if (a) deployer = { address: a, createdAt: (tx.blockTime || 0) * 1000 || null };
    }
  } catch { /* deployer unknown */ }
  return { contract, holders, deployer };
}
