import { h } from '../dom.js';
import { api } from '../api.js';
import { detect, countUp } from '../util.js';
import { icon } from '../icons.js';
import { mountOrb } from '../orb.js';
import { theme, startTide } from '../theme.js';
import { go, themeButton } from '../main.js';

const EXAMPLES = [
  ['USDC on Ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
  ['SUI', '0x2::sui::SUI'],
  ['wSOL on Solana', 'So11111111111111111111111111111111111111112'],
];
const TRACE = [
  ['k', 'sniff 0x7f3a...c91e'], ['m', '> tatum  eth_getCode            -> 11,482 bytes'], ['m', '> scan   PUSH4 selectors      -> 94 found'],
  ['w', '! mint(address,uint256) reachable, owner not renounced'], ['m', '> tatum  eth_getStorageAt (EIP-1967) -> proxy slot set'],
  ['m', '> dexscreener  pairs           -> liquidity $4,210'], ['k', '> walrus recall "mintable proxy fresh deployer"'],
  ['w', '! match: session 7, lift 6.2, trend rising'], ['k', 'risk 38 -> 74 with memory'],
];

export async function mount(root) {
  let stats = null;
  try { stats = await api('/api/public/stats'); } catch { stats = { demo: true, sessions: [], memories: { live: 0, walrus: 0 }, latest: null }; }
  const by = stats.latest?.byChain || {};

  const input = h('input', { type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Paste a token address', 'aria-label': 'Token address' });
  const chainTag = h('span', { class: 'chain' }, 'Auto-detect chain');
  const hint = h('div', { class: 'hint', role: 'alert' });
  const submit = () => {
    const d = detect(input.value);
    if (!d || d.error) { hint.textContent = d?.error || 'Paste a token address first.'; input.focus(); return; }
    go(`/t/${d.chain}/${encodeURIComponent(input.value.trim())}`);
  };
  input.addEventListener('input', () => { const d = detect(input.value); hint.textContent = ''; chainTag.textContent = d && !d.error ? d.label : 'Auto-detect chain'; chainTag.classList.toggle('ok', !!d && !d.error); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const scents = Array.from({ length: 6 }, (_, i) => h('i', { class: 'scent', style: { left: '41%', top: '19%', '--dx': `${-120 - i * 38}px`, '--dy': `${-10 + (i % 3) * 22}px`, animationDelay: `${i * 0.9}s` } }));
  const mascot = h('div', { class: 'mascot rise', style: { animationDelay: '.5s' } }, h('img', { src: '/mascot/walrus-sleuth.png', alt: 'Green walrus detective holding a magnifying glass', width: 800, height: 928 }), ...scents);
  const canvas = h('canvas', { class: 'orb', 'aria-hidden': 'true' });
  const tideTxt = h('b', {}, '');
  const tideFill = h('i', {});
  const node = (cls, ic, name, val, sub) => h('div', { class: `node ${cls}` }, h('div', { class: 'ic' }, ic), h('div', {}, h('b', {}, name), h('small', {}, `${val} ${sub}`)));

  const hero = h('header', { class: 'hero' },
    h('div', { class: 'blobs', 'aria-hidden': 'true' }, h('div', { class: 'blob a' }), h('div', { class: 'blob b' }), h('div', { class: 'blob c' })), canvas,
    h('div', { class: 'grain' }),
    h('svg', { class: 'hero-links', viewBox: '0 0 1000 620', preserveAspectRatio: 'none', 'aria-hidden': 'true', html: '<path d="M0 190 H180 C260 190 270 250 360 250"/><path d="M60 480 H210 C280 480 300 420 380 420"/><path d="M1000 170 H820 C740 170 730 240 640 240"/><path d="M940 440 H800 C720 440 700 390 620 390"/>' }),
    h('nav', { class: 'nav glass', 'aria-label': 'Main' },
      h('a', { class: 'brand', href: '/', 'data-link': '' }, h('img', { src: '/mascot/walrus-avatar.png', alt: '' }), 'WalSniff'),
      h('a', { href: '#how', class: 'hide-s' }, 'How it works'), h('a', { href: '#walrus' }, 'Walrus Memory'), h('a', { href: '#tatum', class: 'hide-s' }, 'Tatum'), h('a', { href: '/admin', 'data-link': '', class: 'hide-s' }, 'Learner'), themeButton()),
    node('l1', 'S', 'Sui', by.sui ?? 0, 'rugs learned'), node('l2', 'E', 'Ethereum', by.ethereum ?? 0, 'rugs learned'),
    node('r1', 'N', 'Solana', by.solana ?? 0, 'rugs learned'), node('r2', 'M', 'Memories', stats.memories.live, stats.memories.walrus ? `(${stats.memories.walrus} on Walrus)` : 'in the case file'),
    h('div', { class: 'hero-core' },
      h('h1', { class: 'rise' }, h('span', { class: 'gl' }, 'Sniff out the rug before it drops')),
      h('p', { class: 'sub rise', style: { animationDelay: '.12s' } }, 'WalSniff reads the contract through Tatum, remembers every trick ruggers use in Walrus Memory, and tells you how risky a token looks. In seconds.'),
      h('div', { class: 'sniffbar glass rise', style: { animationDelay: '.22s' } }, h('span', { html: icon('search') }), input, chainTag, h('button', { class: 'btn pri', onclick: submit }, 'Sniff it')),
      hint,
      h('div', { class: 'examples rise', style: { animationDelay: '.3s' } }, h('span', { class: 'dim' }, stats.demo ? 'Demo mode, sample data. Try:' : 'Try:'), EXAMPLES.map(([l, a]) => h('button', { class: 'chip', onclick: () => { input.value = a; input.dispatchEvent(new Event('input')); submit(); } }, l)))),
    mascot,
    h('div', { class: 'tide glass', title: 'The glow follows your local time of day' }, h('div', { class: 'bar' }, tideFill), h('div', {}, tideTxt, h('div', { class: 'dim', style: { fontSize: '.78rem' } }, 'Tide clock'))),
    h('svg', { class: 'waves', viewBox: '0 0 1440 90', preserveAspectRatio: 'none', 'aria-hidden': 'true', html: '<path fill="var(--pri)" fill-opacity=".25" d="M0 50 Q180 10 360 50 T720 50 T1080 50 T1440 50 V90 H0Z"/><path fill="var(--pri)" fill-opacity=".35" d="M-60 62 Q120 28 300 62 T660 62 T1020 62 T1380 62 V90 H-60Z" style="animation-duration:12s;animation-direction:alternate-reverse"/>' }));

  const stopTide = startTide((s) => { tideTxt.textContent = `${s.phase} · ${s.time}`; tideFill.style.height = `${Math.round(s.level * 100)}%`; });
  const orb = mountOrb(canvas, { getTheme: theme });
  const onTheme = () => {};
  addEventListener('themechange', onTheme);
  const tilt = (e) => { const b = hero.getBoundingClientRect(); const x = (e.clientX - b.left) / b.width - 0.5, y = (e.clientY - b.top) / b.height - 0.5; mascot.style.transform = `translate(${x * -18}px, ${y * -10}px) rotate(${x * 2.5}deg)`; };
  hero.addEventListener('pointermove', tilt);

  const live = h('div', { class: 'stat-row' },
    ...[['Memories on Walrus', stats.memories.walrus], ['Sessions kept', stats.sessions.length], ['Patterns in latest session', stats.latest?.patterns ?? 0]].map(([l, v]) => { const b = h('b', {}, '0'); countUp(b, v, 1600); return h('div', { class: 'stat' }, b, h('span', {}, l)); }));

  const term = h('div', { class: 'term', role: 'img', 'aria-label': 'Example scan trace' });
  TRACE.forEach(([c, t], i) => term.append(h('div', { class: `ln ${c}`, style: { animationDelay: `${0.6 + i * 0.7}s` } }, t)));

  const page = h('main', {},
    hero,
    h('section', { class: 'blk wrap', id: 'how' },
      h('h2', {}, 'A detective that keeps its case files'),
      h('p', { class: 'lead' }, 'Most token checkers run the same rules forever. WalSniff learns from every new rug and uses what it learned on the very next scan.'),
      h('div', { class: 'steps' },
        h('div', { class: 'step glass' }, h('h3', {}, 'Collect the evidence'), h('p', {}, 'Tatum RPC reads the contract on Sui, Ethereum or Solana. DexScreener adds the market, socials and pair history. TokenSniffer or SolSniffer scores come along when keys are set.')),
        h('div', { class: 'step glass' }, h('h3', {}, 'Open the case file'), h('p', {}, 'The scanner recalls patterns, repeat deployers and code clusters from Walrus Memory and checks them against what it just found.')),
        h('div', { class: 'step glass' }, h('h3', {}, 'Deliver the verdict'), h('p', {}, 'A transparent score, the exact signals behind it, and an AI-written verdict. You also see how much memory changed the score.')))),
    h('section', { class: 'blk wrap', id: 'walrus' },
      h('div', { class: 'cols' },
        h('div', { class: 'rant glass' },
          h('h3', {}, 'Walrus Memory is the whole brain, not a side feature'),
          h('p', {}, 'Every learning session opens its own Walrus Memory namespace. The patterns it mined, the deployers that keep rugging, the code that keeps getting copy-pasted and even the risk model weights are written there as memories.'),
          h('ul', {},
            h('li', {}, h('span', {}, h('b', {}, 'Recall decides the score. '), 'The scanner recalls memories for every token, and semantic recall means a contract that only resembles a known rug still finds its case.')),
            h('li', {}, h('span', {}, h('b', {}, 'Memory Lens shows the receipts. '), 'Each result shows the score without memory next to the score with it, and lists the memories that moved it.')),
            h('li', {}, h('span', {}, h('b', {}, 'Fresh on purpose. '), 'Only the latest two sessions are kept. Older ones are retired so WalSniff chases the tricks ruggers use now.')),
            h('li', {}, h('span', {}, h('b', {}, 'Honest when offline. '), 'If Walrus cannot be reached, WalSniff uses a local mirror and labels it on the page.'))),
          live),
        h('div', { class: 'card glass lens', 'aria-label': 'Example of Memory Lens' },
          h('h3', {}, 'Memory Lens, example scan'),
          ...[['Without memory', 38, 'var(--warn)'], ['With Walrus Memory', 74, 'var(--bad)']].map(([l, v, c]) => { const f = h('div', { class: 'fill', style: { background: c } }); setTimeout(() => (f.style.width = v + '%'), 700); return h('div', { class: 'row' }, h('span', { class: 'lbl' }, l), h('div', { class: 'track' }, f), h('b', {}, v)); }),
          h('p', { class: 'muted', style: { fontSize: '.92rem' } }, 'The jump comes from three memories: a repeat deployer, a code cluster that was 90% rugged, and a rising combination pattern.'),
          h('div', { class: 'dim', style: { fontSize: '.8rem' } }, 'Illustration. Real scans show their own memories.')))),
    h('section', { class: 'blk wrap', id: 'tatum' },
      h('div', { class: 'cols' },
        term,
        h('div', { class: 'rant glass' },
          h('h3', {}, 'Tatum is the nose'),
          h('p', {}, 'One key gives WalSniff production RPC for Sui, Ethereum and Solana, so there are no nodes to babysit and every chain is read the same way.'),
          h('ul', {},
            h('li', {}, h('span', {}, h('b', {}, 'Sui: '), 'reads the Move ABI with sui_getNormalizedMoveModulesByPackage to see if a treasury cap is still exposed, then checks supply and metadata.')),
            h('li', {}, h('span', {}, h('b', {}, 'Ethereum: '), 'pulls bytecode with eth_getCode, walks every opcode and decodes function selectors to catch mint, blacklist, tax and trading switches. Proxy slots come from eth_getStorageAt.')),
            h('li', {}, h('span', {}, h('b', {}, 'Solana: '), 'getAccountInfo for mint and freeze authority and Token-2022 extensions, getTokenLargestAccounts for whale concentration, and signatures for deployer and wallet age.')),
            h('li', {}, h('span', {}, h('b', {}, 'The learner uses the same eyes. '), 'Training tokens go through the exact collector the scanner uses, so what it learns applies to what you paste.')))))),
    h('div', { class: 'tusks', 'aria-hidden': 'true' }, h('img', { src: '/mascot/walrus-tusks.png', alt: '' })),
    h('footer', { class: 'foot wrap' }, h('p', {}, 'WalSniff reports risk signals, not verdicts of fraud. Always do your own research. Built for the Tatum x Walrus Total Recall hackathon.')));
  root.append(page);
  return () => { orb.destroy(); stopTide(); removeEventListener('themechange', onTheme); };
}
