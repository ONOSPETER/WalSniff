// Address -> chain detection and per-chain constants.
export const EVM_CHAINS = { ethereum: { id: 1, tatum: 'ethereum-mainnet' }, base: { id: 8453, tatum: 'base-mainnet' }, bsc: { id: 56, tatum: 'bsc-mainnet' } };
export const CHAINS = ['sui', 'ethereum', 'solana'];
export const CHAIN_LABEL = { sui: 'Sui', ethereum: 'Ethereum', solana: 'Solana', base: 'Base', bsc: 'BNB Chain' };

const RE_EVM = /^0x[0-9a-fA-F]{40}$/;
const RE_SUI_TYPE = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;
const RE_SUI_PKG = /^0x[0-9a-fA-F]{64}$/;
const RE_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectChain(raw) {
  const address = String(raw || '').trim();
  if (RE_SUI_TYPE.test(address)) return { ok: true, chain: 'sui', address };
  if (RE_EVM.test(address)) return { ok: true, chain: 'ethereum', address: address.toLowerCase(), evm: true };
  if (RE_SUI_PKG.test(address)) return { ok: false, hint: 'That looks like a Sui package ID. Paste the full coin type instead, like 0x...::module::TOKEN.' };
  if (RE_SOL.test(address)) return { ok: true, chain: 'solana', address };
  return { ok: false, hint: 'Paste an Ethereum (0x...), Sui (0x...::module::TYPE) or Solana token address.' };
}
export const isEvm = (c) => c in EVM_CHAINS;
