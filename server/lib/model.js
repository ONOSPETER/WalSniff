// Risk model: evidence -> flags -> logistic risk score. Pure functions (no I/O) so they are easy to test.
// Flags in market/social categories are NOT learned: after a rug their values leak the label (liquidity is gone), so the
// learner only fits weights on "pre-rug knowable" flags and market flags keep fixed priors.

const pct = (n) => `${n.toFixed(1)}%`;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export const FLAGS = [
  { id: 'mintable', cat: 'control', learn: true, prior: 1.6, label: 'Supply can still be minted', test: (e) => e.contract?.mintable === true && { sev: 1, why: e.chain === 'solana' ? 'A mint authority is still set, so new tokens can be created.' : e.chain === 'sui' ? 'A public function exposes the treasury cap, so new coins can be minted.' : 'The bytecode exposes a mint function.' } },
  { id: 'freeze_authority', cat: 'control', learn: true, prior: 0.7, label: 'Accounts can be frozen', test: (e) => (e.contract?.freezeAuthority === true || e.contract?.denyCap === true) && { sev: 1, why: 'A freeze authority or deny list lets the team block holders from moving tokens.' } },
  { id: 'permanent_delegate', cat: 'control', learn: true, prior: 1.2, label: 'Permanent delegate extension', test: (e) => e.contract?.permanentDelegate === true && { sev: 1, why: 'Token-2022 permanent delegate can move or burn any holder balance.' } },
  { id: 'transfer_fee', cat: 'control', learn: true, prior: 0.6, label: 'Transfer fee extension', test: (e) => e.contract?.transferFee === true && { sev: 0.7, why: 'A transfer fee is built into the token and may be changed.' } },
  { id: 'upgradeable', cat: 'control', learn: true, prior: 0.5, label: 'Upgradeable contract', test: (e) => e.contract?.upgradeable === true && { sev: 1, why: 'The contract sits behind an upgradeable proxy, so its logic can change.' } },
  { id: 'proxy', cat: 'control', learn: true, prior: 0.5, label: 'Proxy or minimal clone', test: (e) => e.contract?.proxy === true && { sev: 0.8, why: 'Logic lives elsewhere, so the visible code is not the whole story.' } },
  { id: 'blacklist', cat: 'control', learn: true, prior: 1.0, label: 'Blacklist controls', test: (e) => e.contract?.blacklist === true && { sev: 1, why: 'The contract has functions that can block specific wallets from trading.' } },
  { id: 'tax_setters', cat: 'control', learn: true, prior: 1.1, label: 'Mutable buy/sell tax', test: (e) => e.contract?.taxSetters === true && { sev: 1, why: 'The owner can change buy or sell fees after launch.' } },
  { id: 'trading_switch', cat: 'control', learn: true, prior: 0.8, label: 'Trading on/off switch', test: (e) => e.contract?.tradingSwitch === true && { sev: 1, why: 'Trading can be enabled or disabled by the owner.' } },
  { id: 'limit_setters', cat: 'control', learn: true, prior: 0.4, label: 'Adjustable wallet limits', test: (e) => e.contract?.limitSetters === true && { sev: 0.7, why: 'Max transaction or wallet limits can be changed.' } },
  { id: 'selfdestruct', cat: 'control', learn: true, prior: 1.2, label: 'Self-destruct opcode', test: (e) => e.contract?.selfdestruct === true && { sev: 1, why: 'The bytecode contains SELFDESTRUCT.' } },
  { id: 'delegatecall', cat: 'control', learn: true, prior: 0.4, label: 'Delegatecall present', test: (e) => e.contract?.delegatecall === true && { sev: 0.7, why: 'DELEGATECALL can execute outside logic with this contract’s storage.' } },
  { id: 'unverified_source', cat: 'control', learn: true, prior: 0.5, label: 'Source code not verified', test: (e) => e.contract?.verified === false && { sev: 1, why: 'No verified source on the explorer, so only bytecode can be checked.' } },
  { id: 'owner_active', cat: 'control', learn: true, prior: 0.3, label: 'Owner not renounced', test: (e) => e.contract?.ownerActive === true && { sev: 0.6, why: 'An owner address still holds admin rights.' } },
  { id: 'top10_concentrated', cat: 'holders', learn: true, prior: 1.2, label: 'Top 10 holders own most supply', test: (e) => e.holders?.top10Pct > 55 && { sev: clamp((e.holders.top10Pct - 55) / 35 + 0.5), why: `Top 10 wallets hold ${pct(e.holders.top10Pct)} of supply (pool vaults can be included).` } },
  { id: 'top_holder_dominant', cat: 'holders', learn: true, prior: 1.0, label: 'One wallet dominates supply', test: (e) => e.holders?.topPct > 30 && { sev: clamp((e.holders.topPct - 30) / 40 + 0.5), why: `Largest holder owns ${pct(e.holders.topPct)} (could be a liquidity pool).` } },
  { id: 'deployer_holds_large', cat: 'holders', learn: true, prior: 1.0, label: 'Deployer holds a large share', test: (e) => e.deployer?.sharePct > 15 && { sev: clamp(e.deployer.sharePct / 40 + 0.4), why: `Deployer wallet still holds ${pct(e.deployer.sharePct)} of supply.` } },
  { id: 'fresh_deployer', cat: 'deployer', learn: true, prior: 0.8, label: 'Brand-new deployer wallet', test: (e) => e.deployer?.ageDays !== undefined && e.deployer.ageDays !== null && e.deployer.ageDays < 3 && { sev: 1, why: `Deployer wallet is ${e.deployer.ageDays.toFixed(1)} days old.` } },
  { id: 'serial_deployer', cat: 'deployer', learn: true, prior: 1.2, label: 'Deployer launched many tokens', test: (e) => e.deployer?.prevTokens >= 3 && { sev: clamp(e.deployer.prevTokens / 8 + 0.3), why: `Same deployer launched ${e.deployer.prevTokens} other tokens.` } },
  { id: 'no_socials', cat: 'social', learn: false, prior: 0.8, label: 'No website or socials', test: (e) => e.market?.found && !(e.token?.websites?.length || e.token?.socials?.length) && { sev: 1, why: 'The pair has no website or social links on DexScreener.' } },
  { id: 'no_profile', cat: 'social', learn: false, prior: 0.3, label: 'No token profile', test: (e) => e.market?.found && !e.token?.imageUrl && { sev: 1, why: 'No profile image or header registered.' } },
  { id: 'thin_liquidity', cat: 'market', learn: false, prior: 1.3, label: 'Thin liquidity', test: (e) => e.market?.liquidityUsd !== null && e.market?.liquidityUsd !== undefined && e.market.liquidityUsd < 10000 && { sev: clamp(1 - e.market.liquidityUsd / 10000, 0.3), why: `Only ${usd(e.market.liquidityUsd)} of liquidity.` } },
  { id: 'price_collapse', cat: 'market', learn: false, prior: 1.6, label: 'Price collapsed', test: (e) => e.market?.priceChange24 <= -70 && { sev: clamp(-e.market.priceChange24 / 100), why: `Price is down ${pct(-e.market.priceChange24)} in 24h.` } },
  { id: 'sell_pressure', cat: 'market', learn: false, prior: 0.7, label: 'Heavy sell pressure', test: (e) => e.market?.buys24 + e.market?.sells24 >= 50 && e.market.sells24 > e.market.buys24 * 1.6 && { sev: 0.8, why: `${e.market.sells24} sells vs ${e.market.buys24} buys in 24h.` } },
  { id: 'very_new', cat: 'market', learn: false, prior: 0.5, label: 'Very new pair', test: (e) => e.market?.ageHours !== null && e.market?.ageHours !== undefined && e.market.ageHours < 6 && { sev: 1 - e.market.ageHours / 6, why: `Pair is only ${e.market.ageHours.toFixed(1)}h old.` } },
  { id: 'wash_volume', cat: 'market', learn: false, prior: 0.7, label: 'Volume far above liquidity', test: (e) => e.market?.liquidityUsd > 0 && e.market.volume24 / e.market.liquidityUsd > 40 && { sev: 0.8, why: 'Daily volume is over 40x liquidity, which can mean wash trading.' } },
  { id: 'sniffer_low', cat: 'thirdparty', learn: false, prior: 1.6, label: 'Low sniffer score', test: (e) => e.sniffer?.available && e.sniffer.score < 60 && { sev: clamp((60 - e.sniffer.score) / 60 + 0.3), why: `${e.sniffer.provider} scored this token ${e.sniffer.score}/100 (higher is safer).` } },
];
export const FLAG_BY_ID = Object.fromEntries(FLAGS.map((f) => [f.id, f]));

export function deriveFlags(ev) {
  const out = [];
  for (const f of FLAGS) {
    let r = null;
    try { r = f.test(ev); } catch { r = null; }
    if (r) out.push({ id: f.id, label: f.label, cat: f.cat, learn: f.learn, sev: clamp(r.sev), why: r.why });
  }
  return out;
}

export const DEFAULT_RULESET = { version: 0, source: 'priors', bias: -2.3, beta: Object.fromEntries(FLAGS.map((f) => [f.id, f.prior])) };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));

export function scoreEvidence(flags, ruleset = DEFAULT_RULESET, memZ = 0) {
  const beta = (id) => ruleset.beta?.[id] ?? FLAG_BY_ID[id]?.prior ?? 0;
  const z0 = ruleset.bias + flags.reduce((a, f) => a + beta(f.id) * f.sev, 0);
  const z = z0 + memZ;
  const risk = sigmoid(z) * 100;
  const contributions = flags.map((f) => ({ ...f, beta: beta(f.id), points: risk - sigmoid(z - beta(f.id) * f.sev) * 100 })).sort((a, b) => b.points - a.points);
  return { risk, z, contributions };
}

export function grade(risk) {
  if (risk < 20) return { key: 'low', label: 'Low risk signals' };
  if (risk < 40) return { key: 'guarded', label: 'Some caution' };
  if (risk < 62) return { key: 'elevated', label: 'Elevated risk' };
  if (risk < 82) return { key: 'high', label: 'High risk' };
  return { key: 'critical', label: 'Critical risk' };
}

// Confidence: share of the expected evidence we actually obtained for this chain.
export function confidence(ev) {
  const want = [['market', 3, !!ev.market?.found], ['contract', 3, !!ev.contract], ['deployer', 1, !!ev.deployer?.address], ['sniffer', 1, !!ev.sniffer?.available]];
  if (ev.chain === 'solana') want.push(['holders', 2, !!ev.holders]);
  const tot = want.reduce((a, w) => a + w[1], 0);
  return Math.round((want.reduce((a, w) => a + (w[2] ? w[1] : 0), 0) / tot) * 100);
}

export function auc(scores, labels) {
  const pos = [], neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// Fit logistic weights on learnable flags, pulled toward the prior ruleset (L2) so small samples cannot go wild.
export function fitRuleset(rows, prior = DEFAULT_RULESET, { epochs = 400, lr = 0.25, lambda = 0.08, prevalence = 0.2 } = {}) {
  const ids = FLAGS.filter((f) => f.learn).map((f) => f.id);
  const beta = Object.fromEntries(ids.map((id) => [id, prior.beta[id] ?? 0]));
  let bias = prior.bias;
  const n = rows.length || 1;
  for (let ep = 0; ep < epochs; ep++) {
    const g = Object.fromEntries(ids.map((id) => [id, 0]));
    let gb = 0;
    for (const r of rows) {
      let z = bias; for (const id of ids) z += beta[id] * (r.x[id] || 0);
      const err = sigmoid(z) - r.y;
      gb += err; for (const id of ids) if (r.x[id]) g[id] += err * r.x[id];
    }
    for (const id of ids) beta[id] -= lr * (g[id] / n + lambda * (beta[id] - (prior.beta[id] ?? 0)));
    bias -= lr * (gb / n + lambda * (bias - prior.bias));
  }
  const pos = rows.filter((r) => r.y).length / n;
  if (pos > 0 && pos < 1) bias += logit(prevalence) - logit(pos); // sample is balanced; real-world rug rate is lower
  const out = { ...prior, bias, beta: { ...prior.beta, ...Object.fromEntries(ids.map((id) => [id, Math.max(0, beta[id])])) } };
  return out;
}

export function evalRuleset(rows, ruleset) {
  const scores = rows.map((r) => ruleset.bias + Object.entries(r.x).reduce((a, [id, v]) => a + (ruleset.beta[id] ?? 0) * v, 0));
  const labels = rows.map((r) => r.y);
  const pred = scores.map((z) => sigmoid(z) >= 0.5);
  const tp = pred.filter((p, i) => p && labels[i]).length, fp = pred.filter((p, i) => p && !labels[i]).length, fn = pred.filter((p, i) => !p && labels[i]).length;
  return { auc: auc(scores, labels), precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, n: rows.length };
}
