// Light/dark mode plus the "tide": local time tints the glow and drives the tide gauge.
export function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('ws-theme', t); } catch { /* storage can be blocked */ } document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#031712' : '#E8F2E8'); }
export const theme = () => document.documentElement.dataset.theme;
export const toggleTheme = () => setTheme(theme() === 'dark' ? 'light' : 'dark');

export function tideState(d = new Date()) {
  const hr = d.getHours() + d.getMinutes() / 60;
  const phase = hr < 5 ? 'Night watch' : hr < 8 ? 'Dawn patrol' : hr < 17 ? 'Daylight' : hr < 20 ? 'Dusk sweep' : 'Night watch';
  const level = 0.5 + 0.5 * Math.sin(((hr - 3) / 12.4) * Math.PI * 2); // semi-diurnal tide, roughly 12.4h
  const warm = hr >= 5 && hr < 8 ? 1 - Math.abs(hr - 6.5) / 1.5 : hr >= 17 && hr < 20 ? 1 - Math.abs(hr - 18.5) / 1.5 : 0;
  const day = Math.sin(((hr - 6) / 24) * Math.PI * 2) * 0.5 + 0.5;
  return { hr, phase, level, warm: Math.max(0, warm), h1: Math.round(138 + day * 22), h2: Math.round(160 + day * 18), time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
}
export function startTide(onTick) {
  const apply = () => { const s = tideState(); const r = document.documentElement.style; r.setProperty('--h1', s.h1); r.setProperty('--h2', s.h2); r.setProperty('--warm', s.warm.toFixed(2)); onTick?.(s); };
  apply(); const id = setInterval(apply, 20000);
  return () => clearInterval(id);
}
