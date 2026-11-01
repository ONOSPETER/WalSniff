// Scan pipeline: evidence -> flags -> memory recall -> baseline vs memory-informed score -> AI verdict.
import crypto from 'node:crypto';
import { collectEvidence } from './evidence.js';
import { deriveFlags, scoreEvidence, DEFAULT_RULESET, grade, confidence, FLAG_BY_ID } from './model.js';
import { askJson } from './adapters/llm.js';
import { cached } from './net.js';

const jobs = new Map();
const STAGES = ['market', 'contract', 'sniffer', 'deployer', 'memory', 'score', 'verdict'];

export function getJob(id) { return jobs.get(id) || null; }

export function startScan(ctx, chain, address) {
  const id = crypto.randomUUID().slice(0, 12);
  const job = { id, chain, address, status: 'running', stages: Object.fromEntries(STAGES.map((s) => [s, 'pending'])), result: null, error: null, createdAt: Date.now() };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), 10 * 60 * 1000).unref?.();
  run(ctx, job).catch((e) => { job.status = 'failed'; job.error = e.message; });
  return job;
}

const memoryNumbers = (store) => store.get('sessions', []).filter((s) => s.status === 'completed' && !s.deletedAt).sort((a, b) => b.number - a.number).slice(0, 2).map((s) => s.number);

async function run(ctx, job) {
  const set = (k, v) => { job.stages[k] = v; };
  const key = `scan:${job.chain}:${job.address}`;
  const ev = await cached(key, 60000, () => collectEvidence(ctx, job.chain, job.address, (n, st) => set(n === 'security' ? 'sniffer' : n, st)));
  for (const s of ['market', 'contract', 'sniffer']) if (job.stages[s] === 'pending' || job.stages[s] === 'running') set(s, 'done');
  set('deployer', ev.deployer?.address ? 'done' : 'skipped');
  if (!ev.market?.found && !ev.contract) {
    job.status = 'failed'; job.error = 'Nothing was found for this address. Check the chain and address, or try again once a pair exists.'; return;
  }
  const flags = deriveFlags(ev);
  set('memory', 'running');
  const mem = await applyMemory(ctx, ev, flags);
  set('memory', 'done'); set('score', 'running');
  const baseline = scoreEvidence(flags, DEFAULT_RULESET, 0);
  const final = scoreEvidence(flags, mem.ruleset, mem.z);
  set('score', 'done'); set('verdict', 'running');
  const g = grade(final.risk);
  const top = final.contributions.slice(0, 8);
  const verdict = await makeVerdict(ctx, ev, { baseline: baseline.risk, final: final.risk, grade: g, top, mem });
  set('verdict', 'done');
  const result = {
    id: job.id, chain: ev.chain, address: ev.address, createdAt: Date.now(), demo: !!ev.demo, demoKind: ev.demo ? ev.demoKind : undefined,
    token: ev.token, market: ev.market, contract: slimContract(ev.contract), holders: ev.holders, deployer: ev.deployer, sniffer: ev.sniffer, gaps: ev.gaps, sources: ev.sources,
    score: { baseline: Math.round(baseline.risk), final: Math.round(final.risk), delta: Math.round(final.risk - baseline.risk), grade: g, confidence: confidence(ev) },
    flags: final.contributions.map((c) => ({ id: c.id, label: c.label, cat: c.cat, sev: Number(c.sev.toFixed(2)), points: Number(c.points.toFixed(1)), why: c.why })),
    memory: { mode: mem.mode, sessions: mem.numbers, rulesetVersion: mem.ruleset.version, rulesetSource: mem.ruleset.source, hits: mem.hits },
    verdict,
  };
  const scans = ctx.store.get('scans', []);
  scans.push({ id: job.id, chain: ev.chain, address: ev.address, deployer: ev.deployer?.address || null, symbol: ev.token?.symbol || null, baseline: result.score.baseline, final: result.score.final, grade: g.key, demo: result.demo, at: Date.now() });
  if (scans.length > 500) scans.splice(0, scans.length - 500);
  ctx.store.set('scans', scans);
  job.result = result; job.status = 'done';
}

function slimContract(c) { if (!c) return null; const { meta, ...rest } = c; return rest; }

async function applyMemory(ctx, ev, flags) {
  const { memory, store } = ctx;
  const numbers = memoryNumbers(store);
  const out = { numbers, mode: 'none', hits: [], z: 0, ruleset: DEFAULT_RULESET };
  if (!numbers.length) return out;
  const ids = flags.map((f) => f.id);
  const words = flags.map((f) => FLAG_BY_ID[f.id]?.label || f.id).join(' ');
  let recalled = { mode: 'none', results: [] };
  try { recalled = await memory.recall(numbers, `${ev.chain} rug pattern ${words}`, 14); } catch { /* recall is best effort */ }
  let rsRec = null;
  try { const r = await memory.recall(numbers, 'risk model weights ruleset', 4); rsRec = r.results.filter((m) => m.type === 'RULESET').sort((a, b) => b.session - a.session)[0]; if (r.mode !== 'none') recalled.mode = recalled.mode === 'walrus' || r.mode === 'walrus' ? 'walrus' : r.mode; } catch { /* fall back to the local ruleset */ }
  out.mode = recalled.mode;
  if (rsRec?.key?.ruleset) { out.ruleset = { ...DEFAULT_RULESET, ...rsRec.key.ruleset }; out.ruleset.source = `Walrus session ${rsRec.session}`; if (rsRec.source === 'local') out.ruleset.source = `local mirror, session ${rsRec.session}`; }
  else { const local = store.get('rulesets', []).sort((a, b) => b.number - a.number)[0]; if (local) { out.ruleset = { ...DEFAULT_RULESET, ...local.ruleset, source: `local, session ${local.number}` }; if (out.mode === 'none') out.mode = 'local'; } }
  const seen = new Set();
  for (const m of recalled.results) {
    if (m.type !== 'PATTERN' || !m.key?.sig || seen.has(m.key.id)) continue;
    if (!m.key.sig.every((id) => ids.includes(id)) || (m.key.chain !== 'any' && m.key.chain !== ev.chain)) continue;
    seen.add(m.key.id);
    const combo = m.key.sig.length >= 2;
    const mult = m.key.trend === 'rising' ? 1.2 : m.key.trend === 'falling' ? 0.7 : 1;
    const z = combo ? Math.min(0.8, 0.25 * Math.log(Math.max(1, m.key.lift)) * mult) : 0;
    out.hits.push({ kind: 'pattern', title: m.key.sig.map((id) => FLAG_BY_ID[id]?.label || id).join(' + '), detail: m.sentence, lift: m.key.lift, trend: m.key.trend, rugRate: m.key.rugRate, session: m.session, source: m.source, z: Number(z.toFixed(2)), note: combo ? 'Combination pattern: adds to the score.' : 'Already weighted in the learned model.' });
    out.z += z;
  }
  const dep = ev.deployer?.address;
  if (dep) for (const r of memory.exact(numbers, 'DEPLOYER', 'address', dep)) {
    const z = Math.min(3, 1.8 + 0.3 * Math.max(0, (r.key.rugs || 2) - 2));
    out.hits.push({ kind: 'deployer', title: 'Known rug deployer', detail: r.text.replace(/^\[.*?\] s\d+ \S+ /, '').replace(/ ::.*$/, ''), session: Number(/ s(\d+) /.exec(r.text)?.[1]), source: r.status === 'walrus' ? 'walrus' : 'local', z, rugs: r.key.rugs });
    out.z += z;
  }
  const ch = ev.contract?.codeHash;
  if (ch) for (const r of memory.exact(numbers, 'CODE_CLUSTER', 'codeHash', ch)) {
    const z = 1.2 * (r.key.rugRate || 0.7);
    out.hits.push({ kind: 'code', title: 'Matches a rugged code cluster', detail: `${r.key.members} tokens share this code, ${Math.round((r.key.rugRate || 0) * 100)}% rugged.`, session: Number(/ s(\d+) /.exec(r.text)?.[1]), source: r.status === 'walrus' ? 'walrus' : 'local', z: Number(z.toFixed(2)), rugRate: r.key.rugRate });
    out.z += z;
  }
  out.z = Math.min(3, out.z);
  return out;
}

async function makeVerdict(ctx, ev, { baseline, final, grade: g, top, mem }) {
  const fallback = () => {
    const lead = top.slice(0, 3).map((t) => t.label.toLowerCase());
    return {
      source: 'rules', headline: { low: 'Few risk signals found', guarded: 'A few things deserve a closer look', elevated: 'Several warning signs line up', high: 'Many warning signs, proceed with great care', critical: 'Strong rug signals across the board' }[g.key],
      summary: lead.length ? `The strongest signals are ${lead.join(', ')}.${mem.hits.length ? ` ${mem.hits.length} learned pattern${mem.hits.length > 1 ? 's' : ''} from Walrus Memory matched this token.` : ' No learned patterns matched.'}` : 'No risk signals were triggered by the evidence that was available.',
      watch: top.slice(0, 4).map((t) => t.why),
    };
  };
  try {
    const ai = await askJson(ctx.settings, 'You are WalSniff, a careful on-chain risk analyst. Given a token risk assessment, write a verdict for a retail user. Never claim certainty or call anything a scam; use "signals" language. JSON: {"headline": string (max 80 chars), "summary": string (max 420 chars, plain language, mention what memory changed if memoryDelta is not 0), "watch": string[] (max 4 short items on what to check or what would change the verdict)}.', {
      risk: { final: Math.round(final), withoutMemory: Math.round(baseline), memoryDelta: Math.round(final - baseline), grade: g.label },
      untrusted: { name: ev.token?.name, symbol: ev.token?.symbol, description: ev.token?.description },
      chain: ev.chain, signals: top.map((t) => ({ signal: t.label, why: t.why, points: Number(t.points.toFixed(1)) })),
      memoryHits: mem.hits.map((h) => ({ title: h.title, detail: h.detail, lift: h.lift, trend: h.trend })), evidenceGaps: ev.gaps.map((x) => x.source + ': ' + x.reason),
    });
    if (ai?.summary) return { source: 'ai', headline: String(ai.headline || g.label).slice(0, 90), summary: String(ai.summary).slice(0, 460), watch: (ai.watch || []).slice(0, 4).map((x) => String(x).slice(0, 140)) };
  } catch { /* fall through to rule-based verdict */ }
  return fallback();
}
export { STAGES as SCAN_STAGES };
