import { h, $ } from './dom.js';
import { toggleTheme, theme, startTide } from './theme.js';
import { icon } from './icons.js';

const app = $('#app');
let cleanup = null;
const routes = [
  [/^\/$/, () => import('./pages/home.js')],
  [/^\/t\/([^/]+)\/(.+)$/, () => import('./pages/token.js')],
  [/^\/admin(\/.*)?$/, () => import('./pages/admin.js')],
];

export function go(path, replace = false) { history[replace ? 'replaceState' : 'pushState']({}, '', path); render(); }
export const themeButton = () => {
  const b = h('button', { class: 'theme-btn', 'aria-label': 'Switch between light and dark mode', onclick: () => { toggleTheme(); b.innerHTML = icon(theme() === 'dark' ? 'sun' : 'moon'); window.dispatchEvent(new Event('themechange')); } });
  b.innerHTML = icon(theme() === 'dark' ? 'sun' : 'moon'); return b;
};

async function render() {
  cleanup?.(); cleanup = null; app.replaceChildren(); window.scrollTo(0, 0);
  const path = location.pathname;
  for (const [re, load] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    try {
      const mod = await load();
      cleanup = (await mod.mount(app, m.slice(1).map((x) => (x ? decodeURIComponent(x) : x)))) || null;
    } catch (e) {
      console.error(e);
      app.replaceChildren(h('div', { class: 'empty', style: { paddingTop: '20vh' } }, h('h2', {}, 'This page failed to load'), h('p', {}, 'Refresh to try again.')));
    }
    return;
  }
  go('/', true);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && a.origin === location.origin && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.pathname + a.search); }
});
addEventListener('popstate', render);
startTide();
render();
