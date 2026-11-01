// Learning sessions: discover -> label -> ingest -> features -> mine -> analyse -> backtest -> memorise.
// Each stage is checkpointed so an interrupted session can resume. Retention keeps only sessions X and X-1.
import crypto from 'node:crypto';
import { discover as dexDiscover, pairsByChain } from './adapters/dexscreener.js';
import { newPools, trendingPools } from './adapters/geckoterminal.js';
import { askJson } from './adapters/llm.js';
import { collectEvidence, hashFrac } from './evidence.js';
import { deriveFlags, FLAGS, FLAG_BY_ID, DEFAULT_RULESET, fitRuleset, evalRuleset } from './model.js';
import { mockCandidates, mockEvidence } from './mock.js';
import { pool } from './net.js';

const STAGES = ['discover', 'label', 'ingest', 'features', 'mine', 'analyse', 'backtest', 'memorise'];
const MINEABLE = new Set(['control', 'holders', 'deployer', 'social']);

// "sui:50,solana:30" -> integer slots per chain that add up to `limit`. Chains without a weight get an equal share.
export function allocateQuota(weightsText, chains, limit) {
  const w = {};
  for (const part of String(weightsText || '').split(',')) { const [c, n] = part.split(':').map((x) => x.trim()); if (chains.includes(c) && Number(n) > 0) w[c] = Number(n); }
  for (const c of chains) if (!w[c]) w[c] = 1;
  const total = chains.reduce((a, c) => a + w[c], 0);
  const q = Object.fromEntries(chains.map((c) => [c, Math.floor((w[c] / total) * limit)]));
  let left = limit - Object.values(q).reduce((a, b) => a + b, 0);
  for (const c of [...chains].sort((a, b) => w[b] - w[a])) { if (left <= 0) break; q[c]++; left--; }
  return q;
}

export function applyRetention(store, memory, newNumber) {
  const sessions = store.get('sessions', []);
  for (const s of sessions) {
    if (s.number <= newNumber - 2 && !s.deletedAt) purgeSession(store, memory, s);
  }
}
export function purgeSession(store, memory, s) {
  for (const k of ['tokens', 'patterns', 'deployers', 'rulesets']) store.set(k, store.get(k, []).filter((r) => r.sid !== s.id));
  const work = store.get('work', {}); delete work[s.id]; store.set('work', work);
  memory.retireSession(s.number);
  s.deletedAt = Date.now();
  s.log = [];
  store.save();
}

export class Learner {
  constructor(ctx) { this.ctx = ctx; this.current = null; this.cancelled = false; this.recoverInterrupted(); }
  get store() { return this.ctx.store; }
  recoverInterrupted() { for (const s of this.store.get('sessions', [])) if (s.status === 'running') { s.status = 'interrupted'; s.error = 'Server restarted mid-session. Resume to continue from the last finished stage.'; } this.store.save(); }
  log(s, msg) { s.log.push({ t: Date.now(), msg }); if (s.log.length > 250) s.log.shift(); this.store.save(); }
  cancel() { this.cancelled = true; }

  start({ resumeId } = {}) {
    if (this.current) throw new Error('A session is already running');
    const sessions = this.store.get('sessions', []);
    let s;
    if (resumeId) {
      s = sessions.find((x) => x.id === resumeId);
      if (!s || s.status !== 'interrupted' && s.status !== 'failed') throw new Error('Only interrupted or failed sessions can resume');
      s.status = 'running'; s.error = null;
    } else {
      const meta = this.store.get('meta', {});
      meta.sessionSeq = (meta.sessionSeq || 0) + 1; this.store.set('meta', meta);
      const { settings, memory } = this.ctx;
      s = { id: crypto.randomUUID(), number: meta.sessionSeq, status: 'running', startedAt: Date.now(), finishedAt: null, namespace: memory.namespace(meta.sessionSeq), demo: settings.demo(), stages: {}, stats: {}, metrics: {}, log: [], error: null,
        config: { windowHours: settings.num('LEARN_WINDOW_HOURS', 48), limit: Math.min(300, settings.num('LEARN_LIMIT', 300)), chains: settings.get('LEARN_CHAINS').split(',').map((c) => c.trim()).filter(Boolean) } };
      sessions.push(s); this.store.set('sessions', sessions);
      applyRetention(this.store, memory, s.number);
      this.log(s, `Session ${s.number} started${s.demo ? ' in demo mode' : ''}. Sessions older than ${s.number - 1} were removed.`);
    }
    this.cancelled = false;
    this.current = s;
    this.run(s).catch((e) => { s.status = 'failed'; s.error = e.message; this.log(s, `Failed: ${e.message}`); }).finally(() => { s.finishedAt = Date.now(); this.current = null; this.store.save(); });
    return s;
  }

  async run(s) {
    const work = this.store.get('work', {});
    const w = (work[s.id] ||= {});
    const fns = { discover: this.discover, label: this.label, ingest: this.ingest, features: this.features, mine: this.mine, analyse: this.analyse, backtest: this.backtest, memorise: this.memorise };
    for (const name of STAGES) {
      if (s.stages[name] === 'done') continue;
      if (this.cancelled) { s.status = 'cancelled'; this.log(s, 'Cancelled by admin.'); return; }
      s.stages[name] = 'running'; this.store.save();
      try { await fns[name].call(this, s, w); s.stages[name] = 'done'; this.store.set('work', work); }
      catch (e) { s.stages[name] = 'failed'; throw new Error(`${name}: ${e.message}`); }
    }
    this.finalize(s, w);
    delete work[s.id]; this.store.set('work', work);
    s.status = 'completed';
    this.log(s, `Session ${s.number} complete.`);
  }

  async discover(s, w) {
    const { settings } = this.ctx;
    if (s.demo) { w.candidates = mockCandidates(s.config.chains, 160, `s${s.number}`); this.log(s, `Generated ${w.candidates.length} demo candidates.`); return; }
    const chains = s.config.chains.filter((c) => ['sui', 'solana', 'ethereum'].includes(c));
    const quotas = allocateQuota(settings.get('LEARN_CHAIN_WEIGHTS'), chains, s.config.limit);
    const cutoff = Date.now() - s.config.windowHours * 36e5;
    const profiles = await dexDiscover().catch(() => []);
    const cands = [];
    for (const chain of chains) {
      try {
        const src = new Map(); // lowercase address -> 'new' | 'control'
        const add = (a, kind) => { const k = a.toLowerCase(); if (!src.has(k)) src.set(k, kind); };
        try { for (const p of await newPools(chain, { cutoff })) if (p.createdAt === null || p.createdAt >= cutoff) add(p.address, 'new'); } catch (e) { this.log(s, `${chain}: new pools unavailable (${e.message})`); }
        for (const r of profiles) if (r.chain === chain) add(r.address, 'new');
        try { for (const p of await trendingPools(chain)) add(p.address, 'control'); } catch { /* control group is optional */ }
        const list = [...src.keys()];
        if (!list.length) { this.log(s, `${chain}: no candidates found`); continue; }
        const originals = new Map();
        const pairs = await pairsByChain(chain, list.slice(0, Math.max(90, quotas[chain] * 3)));
        const seen = new Set();
        for (const p of pairs) {
          const addr = p.base.address; if (!addr) continue;
          const k = addr.toLowerCase(), kind = src.get(k);
          if (!kind || seen.has(k) || (kind === 'new' && !(p.createdAt >= cutoff))) continue;
          seen.add(k); originals.set(k, addr);
          cands.push({ chain, address: addr, pair: p, src: kind });
        }
        this.log(s, `${chain}: ${[...seen].length} candidates (${cands.filter((c) => c.chain === chain && c.src === 'new').length} new, ${cands.filter((c) => c.chain === chain && c.src === 'control').length} control)`);
      } catch (e) { this.log(s, `${chain}: discovery failed (${e.message})`); }
    }
    if (!cands.length) throw new Error('No tokens were found. Check your network, or widen the discovery window in Settings.');
    w.candidates = cands; w.quotas = quotas;
    this.log(s, `${cands.length} candidate tokens. Slots: ${Object.entries(quotas).map(([c, n]) => `${c} ${n}`).join(', ')}.`);
  }

  label(s, w) {
    const { settings } = this.ctx;
    const floor = settings.num('RUG_LIQUIDITY_FLOOR_USD', 500), drop = settings.num('RUG_DROP_PCT', 90), surv = settings.num('SURVIVOR_MIN_LIQUIDITY_USD', 5000);
    const out = [];
    for (const c of w.candidates) {
      if (s.demo) { out.push({ ...c, label: mockEvidence(c.chain, c.address).demoKind, labelReason: 'Demo label' }); continue; }
      const p = c.pair, liq = p.liquidityUsd ?? 0, d24 = p.priceChange?.h24, tx = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
      const age = (Date.now() - p.createdAt) / 36e5;
      if (c.src !== 'control' && age >= 1 && tx >= 20 && (liq < floor || (d24 !== undefined && d24 <= -drop))) out.push({ ...c, label: 'RUG', labelReason: liq < floor ? `Liquidity fell to $${Math.round(liq)} after ${tx} trades` : `Price down ${Math.abs(d24).toFixed(0)}% in 24h` });
      else if (liq >= surv && age >= 6 && (d24 === undefined || d24 > -50)) out.push({ ...c, label: 'SURVIVOR', labelReason: `Liquidity $${Math.round(liq)} and stable price` });
    }
    // Balance each chain on its own so a flood of Solana tokens cannot crowd out Sui.
    const kept = [];
    for (const chain of [...new Set(out.map((t) => t.chain))]) {
      const rugs = out.filter((t) => t.chain === chain && t.label === 'RUG'), ok = out.filter((t) => t.chain === chain && t.label === 'SURVIVOR');
      const keepOk = Math.min(ok.length, Math.max(5, rugs.length));
      const slice = [...rugs, ...ok.slice(0, keepOk)].slice(0, w.quotas?.[chain] ?? Infinity);
      kept.push(...slice);
      this.log(s, `${chain}: ${slice.filter((t) => t.label === 'RUG').length} rugs, ${slice.filter((t) => t.label === 'SURVIVOR').length} survivors`);
    }
    w.tokens = kept.slice(0, s.config.limit);
    const rugTotal = w.tokens.filter((t) => t.label === 'RUG').length;
    this.log(s, `Labelled ${rugTotal} rugs and ${w.tokens.length - rugTotal} survivors from ${w.candidates.length} candidates (unknowns dropped).`);
    if (rugTotal < 3) throw new Error('Fewer than 3 rugs were found. Widen the discovery window or relax the rug rules in Settings.');
  }

  async ingest(s, w) {
    const conc = this.ctx.settings.num('LEARN_CONCURRENCY', 4);
    const res = await pool(w.tokens, conc, (t) => collectEvidence(this.ctx, t.chain, t.address, () => {}, { forced: t.label }), {
      shouldStop: () => this.cancelled,
      onProgress: (d, n) => { if (d % 25 === 0 || d === n) this.log(s, `Ingested ${d}/${n} tokens`); },
    });
    let failed = 0;
    w.tokens = w.tokens.map((t, i) => { const r = res[i]; if (r?.ok) return { ...t, ev: r.value, pair: undefined }; failed++; return null; }).filter(Boolean);
    if (failed) this.log(s, `${failed} tokens failed to load and were skipped.`);
    if (w.tokens.length < 10) throw new Error('Too few tokens could be loaded to learn from.');
  }

  features(s, w) {
    for (const t of w.tokens) {
      const flags = deriveFlags(t.ev);
      t.flags = flags.map((f) => f.id);
      t.mine = flags.filter((f) => MINEABLE.has(f.cat)).map((f) => f.id);
      t.x = Object.fromEntries(flags.filter((f) => f.learn).map((f) => [f.id, f.sev]));
      t.codeHash = t.ev.contract?.codeHash || null;
      t.deployer = t.ev.deployer?.address || null;
    }
    this.log(s, `Built features for ${w.tokens.length} tokens (${FLAGS.filter((f) => f.learn).length} learnable signals; market signals excluded to avoid label leakage).`);
  }

  mine(s, w) {
    const rugs = w.tokens.filter((t) => t.label === 'RUG'), ctl = w.tokens.filter((t) => t.label === 'SURVIVOR');
    const prev = this.previous(s);
    const prevPatterns = prev ? this.store.get('patterns', []).filter((p) => p.sid === prev.id) : [];
    const res = new Map();
    const consider = (sig, chain) => {
      const has = (t) => sig.every((id) => t.mine.includes(id)) && (chain === 'any' || t.chain === chain);
      const R = rugs.filter((t) => chain === 'any' || t.chain === chain), S = ctl.filter((t) => chain === 'any' || t.chain === chain);
      const aR = R.filter(has).length, aS = S.filter(has).length;
      if (aR < 3 || R.length < 5) return;
      const pr = (aR + 0.5) / (R.length + 1), ps = (aS + 0.5) / (S.length + 1), lift = pr / ps;
      if (pr < 0.15 || lift < 1.5) return;
      const id = `${[...sig].sort().join('+')}@${chain}`;
      const before = prevPatterns.find((p) => p.id === id);
      const trend = !prev ? 'new' : !before ? 'new' : lift - before.lift > 0.5 ? 'rising' : lift - before.lift < -0.5 ? 'falling' : 'steady';
      res.set(id, { sid: s.id, id, sig: [...sig].sort(), chain, supportRug: aR, supportCtl: aS, rugs: R.length, controls: S.length, rugRate: aR / (aR + aS), lift: Number(lift.toFixed(2)), trend, prevLift: before?.lift ?? null, trick: null, examples: R.filter(has).slice(0, 3).map((t) => t.ev.token?.symbol || t.address.slice(0, 8)) });
    };
    const ids = [...new Set(w.tokens.flatMap((t) => t.mine))];
    const chains = ['any', ...new Set(w.tokens.map((t) => t.chain))];
    for (const c of chains) {
      for (const a of ids) consider([a], c);
      if (c === 'any') for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) consider([ids[i], ids[j]], c);
    }
    w.patterns = [...res.values()].sort((a, b) => b.lift * Math.sqrt(b.supportRug) - a.lift * Math.sqrt(a.supportRug)).slice(0, 30);
    const dep = {};
    for (const t of rugs) if (t.deployer) (dep[t.deployer] ||= []).push(t);
    w.deployers = Object.entries(dep).filter(([, v]) => v.length >= 2).map(([address, v]) => ({ sid: s.id, address, chain: v[0].chain, rugs: v.length, symbols: v.slice(0, 4).map((t) => t.ev.token?.symbol) })).slice(0, 20);
    const code = {};
    for (const t of w.tokens) if (t.codeHash) (code[t.codeHash] ||= []).push(t);
    w.clusters = Object.entries(code).map(([hash, v]) => ({ hash, members: v.length, rugRate: v.filter((t) => t.label === 'RUG').length / v.length, chain: v[0].chain })).filter((c) => c.members >= 3 && c.rugRate >= 0.7).slice(0, 10);
    this.log(s, `Found ${w.patterns.length} patterns, ${w.deployers.length} repeat deployers, ${w.clusters.length} code clusters.`);
  }

  async analyse(s, w) {
    const label = (id) => FLAG_BY_ID[id]?.label || id;
    const top = w.patterns.slice(0, 8);
    let ai = null;
    try {
      ai = await askJson(this.ctx.settings, 'You analyse crypto rug-pull patterns. For each pattern write one plain sentence (max 24 words) describing the trick it represents and why it helps ruggers. Also write "summary": two sentences on what changed in this batch of rugs. JSON: {"patterns":[{"id":string,"trick":string}],"summary":string}.',
        { patterns: top.map((p) => ({ id: p.id, signals: p.sig.map(label), chain: p.chain, rugRate: Number(p.rugRate.toFixed(2)), lift: p.lift, trend: p.trend })) });
    } catch (e) { this.log(s, `AI analysis skipped: ${e.message}`); }
    const tricks = Object.fromEntries((ai?.patterns || []).map((p) => [p.id, String(p.trick).slice(0, 220)]));
    for (const p of w.patterns) p.trick = tricks[p.id] || `${p.sig.map(label).join(' and ')} appeared in ${p.supportRug} rugs against ${p.supportCtl} survivors.`;
    w.summary = ai?.summary ? String(ai.summary).slice(0, 400) : `${w.patterns.length} signal patterns separate this batch of rugs from survivors${w.patterns[0] ? `, led by "${w.patterns[0].sig.map(label).join(' + ')}"` : ''}.`;
    this.log(s, ai ? 'AI named the tricks behind each pattern.' : 'Wrote rule-based pattern notes (no AI key set).');
  }

  backtest(s, w) {
    const prev = this.previous(s);
    const prevRs = prev ? this.store.get('rulesets', []).find((r) => r.sid === prev.id) : null;
    const prior = prevRs?.ruleset || DEFAULT_RULESET;
    const rows = w.tokens.map((t) => ({ a: t.address, y: t.label === 'RUG' ? 1 : 0, x: t.x }));
    const train = rows.filter((r) => hashFrac(r.a) >= 0.2), test = rows.filter((r) => hashFrac(r.a) < 0.2);
    const enough = test.filter((r) => r.y).length >= 3 && test.filter((r) => !r.y).length >= 3;
    const fitTrain = fitRuleset(train, prior);
    const m = enough ? evalRuleset(test, fitTrain) : evalRuleset(rows, fitTrain);
    const base = enough ? evalRuleset(test, DEFAULT_RULESET) : evalRuleset(rows, DEFAULT_RULESET);
    const prv = prevRs ? (enough ? evalRuleset(test, prevRs.ruleset) : evalRuleset(rows, prevRs.ruleset)) : null;
    const final = fitRuleset(rows, prior);
    final.version = s.number; final.source = `session ${s.number}`;
    w.ruleset = final;
    s.metrics = { auc: m.auc, precision: m.precision, recall: m.recall, aucPriors: base.auc, aucPrev: prv?.auc ?? null, nTrain: train.length, nTest: enough ? test.length : rows.length, holdout: enough };
    this.log(s, `Backtest AUC ${m.auc?.toFixed(3)} (priors ${base.auc?.toFixed(3)}${prv ? `, previous session ${prv.auc?.toFixed(3)}` : ''})${enough ? '' : ' - small sample, scored in-sample'}.`);
  }

  async memorise(s, w) {
    const { memory } = this.ctx;
    const label = (id) => FLAG_BY_ID[id]?.label || id;
    const rugs = w.tokens.filter((t) => t.label === 'RUG').length, ctl = w.tokens.length - rugs;
    const write = (r) => memory.remember({ sid: s.id, number: s.number, ...r });
    const recs = [];
    for (const p of w.patterns) recs.push({ type: 'PATTERN', chain: p.chain, sentence: `Rug pattern on ${p.chain}: ${p.sig.map(label).join(' + ')}. Lift ${p.lift}, ${p.supportRug} rugs vs ${p.supportCtl} survivors, trend ${p.trend}. ${p.trick}`, key: { id: p.id, sig: p.sig, chain: p.chain, lift: p.lift, trend: p.trend, supportRug: p.supportRug, supportCtl: p.supportCtl, rugRate: Number(p.rugRate.toFixed(2)) } });
    for (const d of w.deployers) recs.push({ type: 'DEPLOYER', chain: d.chain, sentence: `Deployer ${d.address} launched ${d.rugs} rugged tokens on ${d.chain}.`, key: { address: d.address, rugs: d.rugs, chain: d.chain } });
    for (const c of w.clusters) recs.push({ type: 'CODE_CLUSTER', chain: c.chain, sentence: `Contracts sharing code fingerprint ${c.hash} on ${c.chain}: ${c.members} tokens, ${(c.rugRate * 100).toFixed(0)}% rugged.`, key: { codeHash: c.hash, members: c.members, rugRate: Number(c.rugRate.toFixed(2)), chain: c.chain } });
    recs.push({ type: 'RULESET', chain: 'any', sentence: `Risk model weights version ${s.number}, backtest AUC ${s.metrics.auc?.toFixed(2)}.`, key: { ruleset: roundRuleset(w.ruleset) } });
    recs.push({ type: 'SESSION_SUMMARY', chain: 'any', sentence: `Session ${s.number}: ${rugs} rugs and ${ctl} survivors. ${w.summary}`, key: { number: s.number, rugs, survivors: ctl, auc: s.metrics.auc } });
    this.log(s, `Writing ${recs.length} memories to ${s.namespace}${this.ctx.memory.configured ? ' on Walrus' : ' (local mirror, Walrus not configured)'}...`);
    let done = 0;
    await pool(recs, 2, async (r) => { if (this.cancelled) throw new Error('cancelled'); const rec = await write(r); if (++done % 10 === 0) this.log(s, `Wrote ${done}/${recs.length} memories`); return rec; }, { shouldStop: () => this.cancelled });
    if (this.cancelled) throw new Error('cancelled');
    if (memory.configured) {
      const fixed = await memory.reconcile(s.id);
      const mine = memory.records().filter((r) => r.sid === s.id);
      const c = { walrus: mine.filter((r) => r.status === 'walrus').length, pending: mine.filter((r) => r.status === 'pending').length, failed: mine.filter((r) => r.status === 'failed').length };
      this.log(s, `Walrus: ${c.walrus} confirmed, ${c.pending} pending, ${c.failed} failed${fixed ? ` (${fixed} settled late)` : ''}.${c.failed ? ` Last error: ${memory.lastError}` : ''}`);
    }
    w.memoryCount = recs.length;
  }

  finalize(s, w) {
    const rugs = w.tokens.filter((t) => t.label === 'RUG').length;
    const mem = this.ctx.memory.records().filter((r) => r.sid === s.id);
    s.stats = { tokens: w.tokens.length, rugs, survivors: w.tokens.length - rugs, patterns: w.patterns.length, deployers: w.deployers.length, clusters: w.clusters.length, byChain: countBy(w.tokens.filter((t) => t.label === 'RUG'), 'chain'), memories: { total: mem.length, walrus: mem.filter((r) => r.status === 'walrus').length, local: mem.filter((r) => r.status === 'local').length, pending: mem.filter((r) => r.status === 'pending').length, failed: mem.filter((r) => r.status === 'failed').length }, summary: w.summary };
    const tokens = this.store.get('tokens', []);
    for (const t of w.tokens) tokens.push({ sid: s.id, chain: t.chain, address: t.address, symbol: t.ev.token?.symbol || null, name: t.ev.token?.name || null, label: t.label, labelReason: t.labelReason, flags: t.flags, codeHash: t.codeHash, deployer: t.deployer, liquidityUsd: t.ev.market?.liquidityUsd ?? null });
    this.store.set('tokens', tokens);
    const patterns = this.store.get('patterns', []); patterns.push(...w.patterns); this.store.set('patterns', patterns);
    const deployers = this.store.get('deployers', []); deployers.push(...w.deployers); this.store.set('deployers', deployers);
    const rs = this.store.get('rulesets', []); rs.push({ sid: s.id, number: s.number, ruleset: roundRuleset(w.ruleset) }); this.store.set('rulesets', rs);
  }

  previous(s) {
    return this.store.get('sessions', []).filter((x) => x.status === 'completed' && x.number < s.number && !x.deletedAt).sort((a, b) => b.number - a.number)[0] || null;
  }
}
const countBy = (arr, k) => arr.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {});
export function roundRuleset(r) { return { version: r.version, source: r.source, bias: Number(r.bias.toFixed(3)), beta: Object.fromEntries(Object.entries(r.beta).map(([k, v]) => [k, Number(v.toFixed(3))])) }; }
export { STAGES };
