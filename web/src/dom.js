// Tiny hyperscript. Strings become text nodes (safe by default); `html` is only used with trusted constants.
const SVG = new Set(['svg', 'circle', 'path', 'g', 'line', 'rect', 'ellipse', 'defs', 'linearGradient', 'stop', 'text', 'title']);
export function h(tag, props = {}, ...kids) {
  const isSvg = SVG.has(tag);
  const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (Array.isArray(c)) c.forEach(add); else if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export function toast(msg, kind = '') {
  const t = h('div', { class: `toast glass ${kind}`, role: 'status' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3200);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
