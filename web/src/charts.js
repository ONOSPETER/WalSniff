// Dependency-free SVG charts. Inputs are numbers; labels go through esc().
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let uid = 0;

export function lineChart({ labels, series, min = 0, max = 1, fmt = (v) => v.toFixed(2), height = 260 }) {
  const W = 700, H = height, L = 42, R = 14, T = 14, B = 30;
  const n = labels.length; if (!n) return '<div class="empty">Run a learning session to draw the curve.</div>';
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R)), y = (v) => T + (1 - (v - min) / (max - min || 1)) * (H - T - B);
  const id = ++uid;
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = min + ((max - min) * i) / 4, yy = y(v); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`; }
  labels.forEach((l, i) => { g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; });
  let paths = '';
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [x(i), y(v)]));
    const clean = pts.filter(Boolean); if (!clean.length) return;
    const d = clean.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    if (si === 0 && clean.length > 1) paths += `<defs><linearGradient id="lg${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".35"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs><path d="${d} L${clean[clean.length - 1][0]} ${H - B} L${clean[0][0]} ${H - B}Z" fill="url(#lg${id})"/>`;
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.6s var(--ease) ${si * 0.2}s forwards"/>`;
    clean.forEach((p, i) => { paths += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--bg)" stroke="${s.color}" stroke-width="2"><title>${esc(s.name)}: ${fmt(s.values[pts.indexOf(p)])}</title></circle>`; });
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Learning curve"><style>@keyframes draw{to{stroke-dashoffset:0}}</style>${g}${paths}</svg>`;
}

export function donut({ parts, center }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1, R = 70, C = 2 * Math.PI * R;
  let off = 0, arcs = '';
  for (const p of parts) { const len = (p.value / total) * C; arcs += `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${p.color}" stroke-width="22" stroke-dasharray="${Math.max(0, len - 3)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)" stroke-linecap="round"><title>${esc(p.label)}: ${p.value}</title></circle>`; off += len; }
  return `<svg viewBox="0 0 200 200" role="img" aria-label="Label mix" style="max-width:230px;margin:0 auto"><circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--line)" stroke-width="22"/>${arcs}<text x="100" y="98" text-anchor="middle" style="font-size:30px;font-weight:800;fill:var(--ink);font-family:var(--font-d)">${esc(center.big)}</text><text x="100" y="118" text-anchor="middle" style="font-size:11px">${esc(center.small)}</text></svg>`;
}

export function hbars(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return items.map((i) => `<div style="display:grid;grid-template-columns:90px 1fr 36px;gap:12px;align-items:center;margin:12px 0;font-size:.9rem"><span class="muted">${esc(i.label)}</span><div style="height:8px;border-radius:8px;background:var(--glass-2);overflow:hidden"><i style="display:block;height:100%;width:${(i.value / max) * 100}%;background:linear-gradient(90deg,var(--pri-2),var(--pri));border-radius:8px"></i></div><b style="text-align:right">${i.value}</b></div>`).join('');
}
