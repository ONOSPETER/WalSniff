const RE_EVM = /^0x[0-9a-fA-F]{40}$/, RE_SUI = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_]\w*::[A-Za-z_]\w*$/, RE_SUI_PKG = /^0x[0-9a-fA-F]{64}$/, RE_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function detect(v) {
  const s = (v || '').trim();
  if (!s) return null;
  if (RE_SUI.test(s)) return { chain: 'sui', label: 'Sui' };
  if (RE_EVM.test(s)) return { chain: 'ethereum', label: 'EVM' };
  if (RE_SUI_PKG.test(s)) return { error: 'That looks like a Sui package ID. Paste the full coin type, like 0x...::module::TOKEN.' };
  if (RE_SOL.test(s)) return { chain: 'solana', label: 'Solana' };
  return { error: 'Paste an Ethereum (0x...), Sui (0x...::module::TYPE) or Solana token address.' };
}
export const CHAIN = { sui: 'Sui', ethereum: 'Ethereum', solana: 'Solana', base: 'Base', bsc: 'BNB Chain' };
export const money = (n) => (n === null || n === undefined ? 'n/a' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(n < 1 ? 6 : 2)}`);
export const pct = (n, d = 1) => (n === null || n === undefined ? 'n/a' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`);
export const short = (a, n = 6) => (a && a.length > n * 2 + 3 ? `${a.slice(0, n + 2)}...${a.slice(-n)}` : a || '');
export const ago = (ts) => { if (!ts) return 'never'; const s = Math.max(1, (Date.now() - ts) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
export const age = (hours) => (hours === null || hours === undefined ? 'n/a' : hours < 1 ? `${Math.round(hours * 60)}m` : hours < 48 ? `${hours.toFixed(1)}h` : `${Math.round(hours / 24)}d`);
export const gradeColor = (k) => ({ low: 'var(--good)', guarded: '#9ADF4F', elevated: 'var(--warn)', high: '#FF8A4C', critical: 'var(--crit)' }[k] || 'var(--pri)');
export function countUp(el, to, ms = 1400, fmt = (v) => Math.round(v)) {
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / ms); el.textContent = fmt(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) el.textContent = fmt(to); else requestAnimationFrame(step);
}
export const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
