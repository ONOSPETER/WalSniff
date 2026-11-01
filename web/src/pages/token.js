import { h } from '../dom.js';
import { api } from '../api.js';
import { detect, CHAIN, money, pct, short, age, gradeColor, countUp, copy } from '../util.js';
import { icon } from '../icons.js';
import { go, themeButton } from '../main.js';
import { toast } from '../dom.js';

const STAGE_LABEL = { market: 'Reading the market (DexScreener)', contract: 'Inspecting the contract (Tatum RPC)', sniffer: 'Asking the sniffers', deployer: 'Tracing the deployer', memory: 'Opening the Walrus case file', score: 'Weighing the evidence', verdict: 'Writing the verdict' };
const EXPLORER = { sui: (a) => `https://suiscan.xyz/mainnet/coin/${a}`, ethereum: (a) => `https://etherscan.io/token/${a}`, base: (a) => `https://basescan.org/token/${a}`, bsc: (a) => `https://bscscan.com/token/${a}`, solana: (a) => `https://solscan.io/token/${a}` };
const CAT = { control: 'Contract', holders: 'Holders', deployer: 'Deployer', market: 'Market', social: 'Social', thirdparty: 'Sniffer' };

export function mount(root, [chain, address]) {
  let stop = false;
  const view = h('main', { class: 'page' });
  const input = h('input', { value: address, 'aria-label': 'Token address', spellcheck: 'false', autocomplete: 'off' });
  const again = () => { const d = detect(input.value); if (!d || d.error) return toast(d?.error || 'Paste a token address'); go(`/t/${d.chain}/${encodeURIComponent(input.value.trim())}`); };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && again());
  root.append(
    h('div', { class: 'topbar glass' }, h('a', { class: 'brand', href: '/', 'data-link': '', style: { display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-d)', fontWeight: 800 } }, h('img', { src: '/mascot/walrus-avatar.png', alt: '', style: { width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover', objectPosition: '50% 30%' } }), h('span', { class: 'hide-s' }, 'WalSniff')),
      h('div', { class: 'sniffbar' }, h('span', { html: icon('search') }), input, h('button', { class: 'btn pri sm', onclick: again }, 'Sniff')), themeButton()),
    view);

  const loading = (stages = {}) => {
    view.replaceChildren(h('div', { class: 'wrap sniffing' },
      h('div', { class: 'pic' }, h('img', { src: '/mascot/walrus-sleuth.png', alt: 'Walrus detective sniffing around' })),
      h('h2', { style: { fontSize: 'clamp(1.6rem,3.4vw,2.4rem)' } }, 'Sniffing around...'),
      h('div', { class: 'stagelist' }, Object.keys(STAGE_LABEL).map((k) => { const st = stages[k] || 'pending'; return h('div', { class: `s ${st === 'running' ? 'run' : st}` }, st === 'running' ? h('span', { class: 'spin' }) : h('span', { class: 'dot', style: { opacity: st === 'pending' ? 0.3 : 1, color: st === 'failed' ? 'var(--warn)' : st === 'done' ? 'var(--pri)' : 'inherit' } }), STAGE_LABEL[k]); }))));
  };
  const fail = (msg) => view.replaceChildren(h('div', { class: 'wrap empty', style: { paddingTop: '8vh' } }, h('img', { src: '/mascot/walrus-wink.png', alt: '' }), h('h2', {}, 'The trail went cold'), h('p', { style: { maxWidth: '48ch', margin: '12px auto 22px' } }, msg), h('a', { class: 'btn pri', href: '/', 'data-link': '' }, 'Try another token')));

  (async () => {
    loading();
    try {
      const { id } = await api('/api/scan', { method: 'POST', body: { input: address } });
      for (let i = 0; i < 120 && !stop; i++) {
        const j = await api(`/api/scan/${id}`);
        if (j.status === 'done') return render(j.result);
        if (j.status === 'failed') return fail(j.error);
        loading(j.stages);
        await new Promise((r) => setTimeout(r, 650));
      }
      if (!stop) fail('This scan is taking too long. Try again in a moment.');
    } catch (e) { if (!stop) fail(e.message); }
  })();

  function stat(label, value, tone) { return h('div', { class: 'card' }, h('small', {}, label), h('b', { style: tone ? { color: tone } : {} }, value)); }

  function render(r) {
    const gc = gradeColor(r.score.grade.key), t = r.token || {}, m = r.market || {};
    const explorer = EXPLORER[r.chain]?.(r.address);
    const links = [m.pairUrl && m.pairUrl !== '#' ? ['DexScreener', m.pairUrl] : null, explorer ? ['Explorer', explorer] : null, ...(t.websites || []).slice(0, 2).map((w) => [w.label || 'Website', w.url]), ...(t.socials || []).slice(0, 5).map((s) => [s.type ? s.type[0].toUpperCase() + s.type.slice(1) : 'Link', s.url])].filter(Boolean);
    const safeUrl = (u) => (/^https?:\/\//.test(u) ? u : '#');

    const ring = 2 * Math.PI * 120;
    const val = h('circle', { class: 'val', cx: 150, cy: 150, r: 120, 'stroke-width': 22, 'stroke-dasharray': ring, 'stroke-dashoffset': ring });
    const num = h('b', {}, '0');
    setTimeout(() => { val.style.strokeDashoffset = ring * (1 - r.score.final / 100); countUp(num, r.score.final, 1500); }, 150);
    const gauge = h('div', { class: 'gauge' }, h('svg', { viewBox: '0 0 300 300', 'aria-hidden': 'true' }, h('circle', { class: 'trk', cx: 150, cy: 150, r: 120, 'stroke-width': 22 }), val), h('div', { class: 'mid' }, num, h('span', {}, 'risk out of 100')));

    const bar = (label, v, color) => { const f = h('div', { class: 'fill', style: { background: color } }); setTimeout(() => (f.style.width = v + '%'), 500); return h('div', { class: 'row' }, h('span', { class: 'muted' }, label), h('div', { class: 'track' }, f), h('b', {}, v)); };
    const d = r.score.delta;
    const delta = h('div', { class: 'delta glass' },
      h('div', { class: 'muted', style: { fontWeight: 600, marginBottom: '4px' } }, 'Memory Lens'),
      bar('Without memory', r.score.baseline, 'var(--ink-3)'), bar('With Walrus Memory', r.score.final, gc),
      h('div', { class: 'dim', style: { fontSize: '.84rem', marginTop: '6px' } }, r.memory.mode === 'none' ? 'No learning session has finished yet, so there is nothing to recall. Run one from the Learner.' : d === 0 ? `Memory agreed with the baseline (${r.memory.rulesetSource}).` : `Memory ${d > 0 ? 'raised' : 'lowered'} the score by ${Math.abs(d)} points using ${r.memory.rulesetSource}${r.memory.mode === 'local' ? '. Walrus is not connected, so this used the local mirror' : ''}.`));

    const verdict = h('section', { class: 'verdict glass rise', style: { '--gc': gc } }, h('div', {}, gauge),
      h('div', {}, h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } }, h('span', { class: 'chip', style: { color: gc, borderColor: gc } }, h('span', { class: 'dot' }), r.score.grade.label), h('span', { class: 'chip' }, `Confidence ${r.score.confidence}%`), h('span', { class: 'chip' }, r.verdict.source === 'ai' ? 'AI verdict' : 'Rule-based verdict')),
        h('h2', {}, r.verdict.headline), h('p', { class: 'sum' }, r.verdict.summary),
        r.verdict.watch?.length ? h('ul', { class: 'watch' }, r.verdict.watch.map((w) => h('li', {}, w))) : null, delta));

    const flags = r.flags.length ? r.flags.map((f) => { const bi = h('i', {}); setTimeout(() => (bi.style.width = Math.min(100, f.points * 3 + 6) + '%'), 400); return h('div', { class: 'flag' }, h('b', {}, f.label, ' ', h('span', { class: 'chip', style: { marginLeft: '6px', padding: '1px 8px', fontSize: '.72rem' } }, CAT[f.cat] || f.cat)), h('span', { class: 'pts' }, `+${f.points.toFixed(0)}`), h('small', {}, f.why), h('div', { class: 'bar' }, bi)); }) : [h('p', { class: 'muted' }, 'No risk signals were triggered by the evidence that was available.')];

    const hits = r.memory.hits.length ? r.memory.hits.map((x) => h('div', { class: 'hit' }, h('div', { class: 't' }, h('span', {}, x.title), x.lift ? h('span', { class: 'chip' }, `lift ${x.lift}${x.trend ? ` · ${x.trend}` : ''}`) : x.rugs ? h('span', { class: 'chip bad' }, `${x.rugs} rugs`) : null), h('p', {}, x.detail), h('div', { class: 'dim', style: { fontSize: '.78rem', marginTop: '6px' } }, `Session ${x.session} · ${x.source === 'walrus' ? 'from Walrus Memory' : 'local mirror'} · ${x.note || (x.z ? `+${x.z} to the model` : '')}`))) : [h('p', { class: 'muted' }, r.memory.mode === 'none' ? 'No sessions to recall from yet.' : 'No remembered pattern matched this token.')];

    const c = r.contract, kv = [];
    const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');
    if (c) {
      if (c.kind === 'solana') kv.push(['Mint authority', c.mintable ? 'Present' : 'Revoked'], ['Freeze authority', yn(c.freezeAuthority)], ['Token-2022', yn(c.token2022)]);
      if (c.kind === 'sui') kv.push(['Mint function exposed', yn(c.mintable)], ['Deny list', yn(c.denyCap)], ['Metadata frozen', yn(c.metadataFrozen)], ['Public functions', c.selectors]);
      if (c.kind === 'evm') kv.push(['Mint function', yn(c.mintable)], ['Blacklist', yn(c.blacklist)], ['Tax setters', yn(c.taxSetters)], ['Trading switch', yn(c.tradingSwitch)], ['Proxy', yn(c.proxy)], ['Owner active', yn(c.ownerActive)], ['Source verified', yn(c.verified)]);
    }
    if (r.holders) kv.push(['Top holder', `${r.holders.topPct.toFixed(1)}%`], ['Top 10 holders', `${r.holders.top10Pct.toFixed(1)}%`]);
    if (r.deployer?.address) kv.push(['Deployer', short(r.deployer.address)], ['Deployer age', r.deployer.ageDays != null ? `${r.deployer.ageDays.toFixed(1)} days` : 'Unknown'], ['Other tokens seen', r.deployer.prevTokens ?? 0]);
    kv.push([r.sniffer?.provider || 'Sniffer score', r.sniffer?.available ? `${r.sniffer.score}/100` : 'Unavailable']);

    view.replaceChildren(h('div', { class: 'wrap' },
      r.demo ? h('div', { class: 'banner warn' }, 'Demo mode: this report uses generated sample data, not the real token. Add a Tatum API key in Learner > Settings to scan live.') : null,
      h('div', { class: 'tokhead rise' }, h('div', { class: 'logo' }, t.imageUrl ? h('img', { src: t.imageUrl, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(document.createTextNode((t.symbol || '?')[0])) }) : (t.symbol || '?')[0]),
        h('div', { style: { minWidth: 0 } }, h('h1', {}, t.name || 'Unknown token', h('span', { class: 'sym' }, t.symbol || '')), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' } }, h('span', { class: 'chip' }, CHAIN[r.chain] || r.chain), h('span', { class: 'addr' }, h('span', { class: 'mono muted' }, short(r.address, 10)), h('button', { class: 'btn sm', 'aria-label': 'Copy address', html: icon('copy', 15), onclick: async () => toast((await copy(r.address)) ? 'Address copied' : 'Copy failed') }))),
          h('div', { class: 'links' }, links.map(([l, u]) => h('a', { class: 'chip', href: safeUrl(u), target: '_blank', rel: 'noopener noreferrer nofollow' }, l, h('span', { html: icon('ext', 13) })))))),
      h('div', { class: 'stats' }, stat('Price', money(m.priceUsd)), stat('Liquidity', money(m.liquidityUsd), m.liquidityUsd < 10000 ? 'var(--warn)' : ''), stat('24h volume', money(m.volume24)), stat('FDV', money(m.fdv ?? m.marketCap)), stat('24h change', pct(m.priceChange24), m.priceChange24 < 0 ? 'var(--bad)' : 'var(--good)'), stat('Pair age', age(m.ageHours)), stat('24h buys / sells', `${m.buys24 ?? 0} / ${m.sells24 ?? 0}`)),
      verdict,
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('h3', {}, 'Why it scored this way'), ...flags),
        h('div', { style: { display: 'grid', gap: '20px' } },
          h('div', { class: 'card' }, h('h3', {}, 'Memories that mattered'), ...hits),
          h('div', { class: 'card' }, h('h3', {}, 'Evidence'), h('dl', { class: 'kv' }, kv.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])), r.gaps.length ? h('div', { class: 'banner', style: { marginTop: '16px', marginBottom: 0 } }, h('b', {}, 'Missing evidence: '), r.gaps.map((g) => `${g.source} (${g.reason})`).join('; ')) : null))),
      h('p', { class: 'disc' }, 'WalSniff reports risk signals from public data and patterns it has learned. It cannot prove a token is safe or fraudulent, and holder figures may include liquidity pool vaults. This is not financial advice.')));
  }
  return () => { stop = true; };
}
