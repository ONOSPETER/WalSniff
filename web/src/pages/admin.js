import { h, toast } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { ago, short, money } from '../util.js';
import { lineChart, donut, hbars } from '../charts.js';
import { go, themeButton } from '../main.js';

const NAV = [['/admin', 'home', 'Overview'], ['/admin/data', 'db', 'Data'], ['/admin/memory', 'brain', 'Memory'], ['/admin/settings', 'gear', 'Settings']];
const STAGES = ['discover', 'label', 'ingest', 'features', 'mine', 'analyse', 'backtest', 'memorise'];
const trendIcon = (t) => ({ rising: '▲ rising', falling: '▼ falling', steady: '● steady', new: '✦ new' }[t] || t);

export async function mount(root) {
  const timers = new Set();
  let dead = false;
  const every = (fn, ms) => { const id = setInterval(fn, ms); timers.add(id); return id; };
  const me = await api('/api/admin/me').catch(() => ({ authed: false, configured: true }));
  if (!me.authed) { gate(root, me, () => go('/admin', true)); return; }

  const sub = location.pathname.replace(/^\/admin\/?/, '') || 'overview';
  const content = h('div', { class: 'main' });
  const shell = h('div', { class: 'adm' },
    h('nav', { class: 'side glass', 'aria-label': 'Learner' }, h('div', { class: 'logo' }, h('img', { src: '/mascot/walrus-avatar.png', alt: 'WalSniff' })),
      NAV.map(([href, ic, label]) => h('a', { href, 'data-link': '', 'data-tip': label, 'aria-label': label, class: (href === '/admin' ? sub === 'overview' : location.pathname === href) ? 'on' : '', html: icon(ic) })),
      h('div', { class: 'sp' }), h('a', { href: '/', 'data-link': '', 'data-tip': 'Public site', 'aria-label': 'Public site', html: icon('search') }),
      h('button', { 'aria-label': 'Sign out', 'data-tip': 'Sign out', html: icon('logout'), onclick: async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); go('/admin', true); } })),
    content);
  root.append(shell);

  const header = (title, extra = []) => h('div', { class: 'head glass' }, h('h1', {}, title), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, h('span', { class: 'chip' }, `Last updated: ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`), ...extra, themeButton()));

  const pages = { overview, data, memory, settings };
  await (pages[sub] || overview)();
  return () => { dead = true; timers.forEach(clearInterval); };

  // ---------------- overview ----------------
  async function overview() {
    let ov = await api('/api/admin/overview');
    const live = h('div', { class: 'panel card' });
    const body = h('div', { style: { display: 'grid', gap: '14px' } });
    const startBtn = h('button', { class: 'btn pri' }), cancelBtn = h('button', { class: 'btn danger', onclick: async () => { await api('/api/admin/sessions/cancel', { method: 'POST', body: {} }); toast('Cancelling after the current step'); } }, 'Cancel');
    startBtn.onclick = async () => { startBtn.disabled = true; try { const r = await api('/api/admin/sessions/start', { method: 'POST', body: {} }); toast(`Session ${r.number} started`); poll(); } catch (e) { toast(e.message); } await refresh(); };
    content.replaceChildren(header('Learner overview', [startBtn, cancelBtn]), live, body);

    let sig = '';
    async function refresh() {
      ov = await api('/api/admin/overview');
      const running = !!ov.current;
      startBtn.innerHTML = `${icon('play', 16)} ${running ? 'Session running' : 'Start learning session'}`; startBtn.disabled = running; cancelBtn.style.display = running ? '' : 'none';
      const s = JSON.stringify([ov.sessions.map((x) => [x.id, x.status, x.deletedAt]), ov.stats.memories, ov.patterns.length]);
      if (s !== sig) { sig = s; drawBody(); }
      drawLive();
    }
    function drawLive() {
      const c = ov.current, last = ov.sessions[ov.sessions.length - 1];
      const stages = c?.stages || last?.stages || {}, status = c?.status || last?.status;
      live.replaceChildren(
        h('div', { class: 'ph' }, h('h3', {}, c ? `Session ${c.number} is learning` : last ? `Session ${last.number}: ${status}` : 'No sessions yet'), last?.demo ? h('span', { class: 'chip warn' }, 'Demo data') : null, ov.memoryError ? h('span', { class: 'chip bad', title: ov.memoryError }, 'Walrus write error') : null),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } }, STAGES.map((k) => h('span', { class: `chip ${stages[k] === 'done' ? 'good' : stages[k] === 'failed' ? 'bad' : ''}`, style: stages[k] === 'running' ? { borderColor: 'var(--pri)', color: 'var(--ink)' } : {} }, stages[k] === 'running' ? h('span', { class: 'spin' }) : null, k))),
        c ? h('div', { class: 'log' }, [...c.log].reverse().slice(0, 8).map((l) => h('div', {}, h('span', {}, new Date(l.t).toLocaleTimeString() + '  '), l.msg))) : last?.error ? h('div', { class: 'banner warn' }, last.error) : last ? h('div', { class: 'muted' }, last.stats?.summary || '') : h('div', { class: 'empty' }, h('img', { src: '/mascot/walrus-wink.png', alt: '' }), h('p', {}, 'Start a learning session to teach WalSniff what rugs look like right now.')));
    }
    function drawBody() {
      const done = ov.sessions.filter((x) => x.status === 'completed'), L = ov.latest, P = ov.prev;
      const dlt = (a, b, fmt = (v) => v) => (b === undefined || b === null || a === null || a === undefined ? '' : h('div', { class: `d ${a >= b ? 'up' : 'down'}`, html: `${icon(a >= b ? 'up' : 'down', 14)} ${a >= b ? '+' : ''}${fmt(a - b)} vs previous` }));
      const kpi = (ic, label, val, d) => h('div', { class: 'kpi' }, h('div', { class: 'ico', html: icon(ic) }), h('small', {}, label), h('b', {}, val), d || h('div', { class: 'd dim' }, 'No comparison yet'));
      const st = ov.stats.memories;
      const kpis = h('div', { class: 'kpis glass' },
        kpi('layers', 'Sessions kept', ov.sessions.filter((x) => x.status === 'completed' && !x.deletedAt).length, h('div', { class: 'd dim' }, `${ov.sessions.length} run in total`)),
        kpi('shield', 'Rugs labelled', L?.stats.rugs ?? 0, dlt(L?.stats.rugs, P?.stats.rugs)),
        kpi('clip', 'Patterns found', L?.stats.patterns ?? 0, dlt(L?.stats.patterns, P?.stats.patterns)),
        kpi('brain', 'Memories live', st.live, h('div', { class: 'd dim' }, `${st.walrus} on Walrus`)),
        kpi('chart', 'Backtest AUC', L?.metrics?.auc != null ? L.metrics.auc.toFixed(3) : 'n/a', dlt(L?.metrics?.auc, P?.metrics?.auc, (v) => v.toFixed(3))));
      const curve = h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Learning curve'), h('div', { class: 'legend' }, h('span', {}, h('i', { style: { background: 'var(--pri)' } }), 'Learned model'), h('span', {}, h('i', { style: { background: 'var(--ink-3)' } }), 'Starting priors'))),
        h('div', { class: 'chart', html: lineChart({ labels: done.map((x) => `S${x.number}`), min: 0.4, max: 1, series: [{ name: 'Learned model', color: 'var(--pri)', values: done.map((x) => x.metrics?.auc ?? null) }, { name: 'Priors', color: 'var(--ink-3)', values: done.map((x) => x.metrics?.aucPriors ?? null) }] }) }),
        h('div', { class: 'dim', style: { fontSize: '.82rem', marginTop: '8px' } }, 'AUC on held-out tokens: 0.5 is a coin flip, 1.0 is perfect separation of rugs from survivors.'));
      const mix = ov.labelMix ? h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Label mix, latest session')), h('div', { class: 'chart', html: donut({ parts: [{ label: 'Rugs', value: ov.labelMix.RUG, color: 'var(--bad)' }, { label: 'Survivors', value: ov.labelMix.SURVIVOR, color: 'var(--pri)' }], center: { big: String(ov.labelMix.RUG + ov.labelMix.SURVIVOR), small: 'tokens analysed' } }) }), h('div', { class: 'legend', style: { justifyContent: 'center', marginTop: '14px' } }, h('span', {}, h('i', { style: { background: 'var(--bad)' } }), `Rugs ${ov.labelMix.RUG}`), h('span', {}, h('i', { style: { background: 'var(--pri)' } }), `Survivors ${ov.labelMix.SURVIVOR}`))) : h('div', { class: 'panel card empty' }, 'The label mix appears after the first session.');
      const chains = L ? Object.entries(L.stats.byChain || {}).map(([label, value]) => ({ label, value })) : [];
      const sessions = h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Sessions')), ...[...ov.sessions].reverse().slice(0, 8).map((s) => {
        const doneN = STAGES.filter((k) => s.stages[k] === 'done').length;
        return h('div', { class: 'sess' }, h('div', { class: 'n' }, s.number), h('div', {}, h('b', {}, `Session ${s.number}`), ' ', h('span', { class: `chip ${s.status === 'completed' ? 'good' : s.status === 'running' ? '' : 'warn'}` }, s.deletedAt ? 'data retired' : s.status)),
          h('div', { style: { display: 'flex', gap: '6px' } }, (s.status === 'interrupted' || s.status === 'failed') && !s.deletedAt ? h('button', { class: 'btn sm', onclick: async () => { try { await api('/api/admin/sessions/resume', { method: 'POST', body: { id: s.id } }); refresh(); } catch (e) { toast(e.message); } } }, 'Resume') : null, !s.deletedAt && s.status !== 'running' ? h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm(`Delete session ${s.number} and retire its memories?`)) return; try { await api('/api/admin/sessions/delete', { method: 'POST', body: { id: s.id } }); refresh(); } catch (e) { toast(e.message); } } }, 'Delete') : null),
          s.status === 'running' ? h('div', { class: 'pbar' }, h('i', { style: { width: `${(doneN / STAGES.length) * 100}%` } })) : h('div', { class: 'dim', style: { fontSize: '.82rem', gridColumn: '2 / -1' } }, s.stats?.tokens ? `${s.stats.rugs} rugs · ${s.stats.survivors} survivors · ${s.stats.memories?.total ?? 0} memories · ${ago(s.finishedAt)}` : s.error || ''));
      }), ov.sessions.length ? null : h('div', { class: 'muted' }, 'Nothing yet.'));
      const patt = h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Top patterns, latest session')), ov.patterns.length ? h('div', { class: 'tblwrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Signals', 'Chain', 'Rugs', 'Survivors', 'Lift', 'Trend'].map((x) => h('th', {}, x)))), h('tbody', {}, ov.patterns.map((p) => h('tr', {}, h('td', { title: p.trick }, p.sig.join(' + ')), h('td', {}, p.chain), h('td', {}, p.supportRug), h('td', {}, p.supportCtl), h('td', {}, h('b', {}, p.lift)), h('td', { style: { color: p.trend === 'rising' ? 'var(--bad)' : p.trend === 'falling' ? 'var(--good)' : '' } }, trendIcon(p.trend))))))) : h('div', { class: 'muted' }, 'No patterns yet.'));
      const deps = h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Repeat deployers')), ov.deployers.length ? h('table', { class: 'tbl' }, h('tbody', {}, ov.deployers.map((d) => h('tr', {}, h('td', { class: 'mono' }, short(d.address, 8)), h('td', {}, d.chain), h('td', {}, `${d.rugs} rugs`))))) : h('div', { class: 'muted' }, 'None found. A repeat deployer needs at least two rugs in one session.'));
      body.replaceChildren(kpis, h('div', { class: 'dash' }, curve, mix), h('div', { class: 'dash3' }, h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Rugs by chain')), chains.length ? h('div', { html: hbars(chains) }) : h('div', { class: 'muted' }, 'Waiting for a session.')), sessions, deps), patt);
    }
    await refresh();
    const poll = () => { every(async () => { if (dead) return; try { await refresh(); } catch { /* keep polling */ } }, ov.current ? 1500 : 6000); };
    let lastRun = !!ov.current;
    every(async () => { if (dead) return; try { await refresh(); if (!!ov.current !== lastRun) { lastRun = !!ov.current; sig = ''; await refresh(); } } catch { /* offline */ } }, 2000);
  }

  // ---------------- data ----------------
  async function data() {
    const tables = ['tokens', 'patterns', 'deployers', 'sessions', 'memory', 'scans', 'rulesets'];
    let tab = 'tokens', page = 0, q = '';
    const holder = h('div', { class: 'panel card' });
    const search = h('input', { class: 'qin', placeholder: 'Filter rows', 'aria-label': 'Filter rows', style: { maxWidth: '260px' }, oninput: (e) => { q = e.target.value; page = 0; clearTimeout(search._t); search._t = setTimeout(load, 250); } });
    const tabs = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    content.replaceChildren(header('Data'), h('div', { class: 'panel card' }, h('div', { class: 'ph' }, tabs, search)), holder);
    const drawTabs = () => tabs.replaceChildren(...tables.map((t) => h('button', { class: `btn sm ${t === tab ? 'pri' : ''}`, onclick: () => { tab = t; page = 0; drawTabs(); load(); } }, t)));
    async function load() {
      const r = await api(`/api/admin/db/${tab}?page=${page}&q=${encodeURIComponent(q)}`);
      const cols = [...new Set(r.rows.flatMap((x) => Object.keys(x)))].filter((c) => !['sid', 'ev', 'x'].includes(c)).slice(0, 9);
      const cell = (v) => { if (v === null || v === undefined) return ''; if (typeof v === 'object') return JSON.stringify(v).slice(0, 80); if (typeof v === 'number' && v > 1.5e12) return new Date(v).toLocaleString(); return String(v).slice(0, 90); };
      holder.replaceChildren(h('div', { class: 'tblwrap' }, r.rows.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, r.rows.map((row) => h('tr', {}, cols.map((c) => h('td', { class: typeof row[c] === 'string' && row[c].length > 20 ? 'mono' : '', title: typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c] ?? '') }, cell(row[c]))))))) : h('div', { class: 'empty' }, 'No rows. Run a learning session or a scan first.')),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px' } }, h('span', { class: 'dim' }, `${r.total} rows`), h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn sm', disabled: page === 0, onclick: () => { page--; load(); } }, 'Previous'), h('button', { class: 'btn sm', disabled: (page + 1) * 25 >= r.total, onclick: () => { page++; load(); } }, 'Next'))));
    }
    drawTabs(); await load();
  }

  // ---------------- memory ----------------
  async function memory() {
    const ov = await api('/api/admin/overview');
    const out = h('div', { class: 'panel card' }, h('div', { class: 'muted' }, 'Ask the case file a question to see what the scanner would recall.'));
    const q = h('input', { class: 'qin', value: 'mintable supply with a fresh deployer on Sui', 'aria-label': 'Recall query' });
    const run = async () => { out.replaceChildren(h('span', { class: 'spin' })); try { const r = await api('/api/admin/memory/recall', { method: 'POST', body: { query: q.value } }); out.replaceChildren(h('div', { class: 'ph' }, h('h3', {}, `${r.results.length} memories recalled`), h('span', { class: `chip ${r.mode === 'walrus' ? 'good' : 'warn'}` }, r.mode === 'walrus' ? 'From Walrus Memory' : r.mode === 'local' ? 'Local mirror' : 'No sessions')), ...r.results.map((m) => h('div', { class: 'hit' }, h('div', { class: 't' }, h('span', {}, m.type), h('span', { class: 'chip' }, `session ${m.session} · ${m.chain}`)), h('p', {}, m.text)))); } catch (e) { out.replaceChildren(h('div', { class: 'banner warn' }, e.message)); } };
    const health = h('div', { class: 'chip' }, 'Not checked');
    const m = ov.stats.memories;
    content.replaceChildren(header('Memory'),
      h('div', { class: 'kpis glass', style: { gridTemplateColumns: 'repeat(3,1fr)' } }, ...[['Memories live', m.live], ['Confirmed on Walrus', m.walrus], ['Sessions readable', ov.stats.sessions.length]].map(([l, v]) => h('div', { class: 'kpi' }, h('small', {}, l), h('b', {}, v)))),
      h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Walrus Memory connection'), health, h('button', { class: 'btn sm', onclick: async () => { const r = await api('/api/admin/settings/test', { method: 'POST', body: { target: 'memory' } }); health.className = `chip ${r.ok ? 'good' : 'warn'}`; health.textContent = r.detail; } }, 'Test connection')), h('p', { class: 'muted' }, ov.stats.walrus ? 'Memories are written to Walrus on Mainnet through your relayer.' : 'Not configured: memories are kept in a local mirror. Add the MemWal account, key and relayer URL in Settings to write to Walrus.')),
      h('div', { class: 'panel card' }, h('div', { class: 'ph' }, h('h3', {}, 'Recall tester')), h('div', { style: { display: 'flex', gap: '10px' } }, q, h('button', { class: 'btn pri', onclick: run }, 'Recall'))), out);
  }

  // ---------------- settings ----------------
  async function settings() {
    let res = await api('/api/admin/settings');
    const edits = {}, clears = new Set();
    const TESTS = { Tatum: 'tatum', 'Walrus Memory': 'memory', 'AI verdict': 'ai', 'Sniffer scores': 'sniffer', System: 'dexscreener' };
    const groups = [...new Set(res.items.map((i) => i.group))];
    const saveBtn = h('button', { class: 'btn pri', onclick: async () => { try { res = await api('/api/admin/settings', { method: 'PUT', body: { set: edits, clear: [...clears] } }); Object.keys(edits).forEach((k) => delete edits[k]); clears.clear(); toast('Settings saved'); draw(); } catch (e) { toast(e.message); } } }, 'Save changes');
    const form = h('div', { class: 'form' });
    function draw() {
      form.replaceChildren(...groups.map((g) => h('div', { class: 'panel card fgroup' }, h('h3', {}, g, res.demo && g === 'System' ? h('span', { class: 'chip warn' }, 'Demo mode is on') : null, TESTS[g] ? (() => { const out = h('span', { class: 'chip' }, 'Not tested'); return [h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { const r = await api('/api/admin/settings/test', { method: 'POST', body: { target: TESTS[g] } }); out.className = `chip ${r.ok ? 'good' : 'warn'}`; out.textContent = r.detail; } catch (er) { out.textContent = er.message; } e.target.disabled = false; } }, 'Test'), out]; })() : null),
        ...res.items.filter((i) => i.group === g).map((i) => {
          const inp = h('input', { type: i.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', value: i.secret ? '' : i.value, placeholder: i.secret ? (i.isSet ? i.value : 'Not set') : '', 'aria-label': i.label, oninput: (e) => { edits[i.key] = e.target.value; clears.delete(i.key); } });
          return h('div', { class: 'field' }, h('div', {}, h('label', {}, i.label), h('small', {}, i.help)), h('div', {}, h('div', { class: 'in' }, inp, i.source === 'admin' ? h('button', { class: 'btn sm', title: 'Remove the saved value', 'aria-label': `Clear ${i.label}`, onclick: () => { clears.add(i.key); delete edits[i.key]; inp.value = ''; inp.placeholder = 'Will be cleared on save'; } }, 'Clear') : null), h('small', { style: { marginTop: '4px' } }, i.isSet ? `Source: ${i.source}` : 'Not set')));
        }))));
    }
    const pw = { current: h('input', { type: 'password', class: 'qin', placeholder: 'Current password', autocomplete: 'current-password' }), next: h('input', { type: 'password', class: 'qin', placeholder: 'New password, 10+ characters', autocomplete: 'new-password' }) };
    content.replaceChildren(header('Settings', [saveBtn]), h('div', { class: 'banner' }, 'Secrets are encrypted at rest and never sent back to the browser. Leave a secret field empty to keep the current value. Values saved here override Replit Secrets.'), form,
      h('div', { class: 'panel card fgroup' }, h('h3', {}, 'Admin password'), h('div', { style: { display: 'grid', gap: '10px', maxWidth: '420px' } }, pw.current, pw.next, h('button', { class: 'btn', onclick: async () => { try { await api('/api/admin/password', { method: 'POST', body: { current: pw.current.value, next: pw.next.value } }); toast('Password changed'); pw.current.value = pw.next.value = ''; } catch (e) { toast(e.message); } } }, 'Change password'))));
    draw();
  }
}

function gate(root, me, done) {
  const pw = h('input', { type: 'password', placeholder: me.configured ? 'Admin password' : 'Choose a password, 10+ characters', autocomplete: me.configured ? 'current-password' : 'new-password', 'aria-label': 'Password' });
  const code = h('input', { type: 'text', placeholder: 'Setup code from the server console', autocomplete: 'off', 'aria-label': 'Setup code' });
  const err = h('div', { class: 'hint', role: 'alert' });
  const submit = async () => { err.textContent = ''; try { await api(me.configured ? '/api/admin/login' : '/api/admin/setup', { method: 'POST', body: me.configured ? { password: pw.value } : { code: code.value, password: pw.value } }); done(); } catch (e) { err.textContent = e.message; } };
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  root.append(h('div', { class: 'login' }, h('div', { class: 'box glass rise' }, h('img', { src: '/mascot/walrus-wink.png', alt: '' }), h('h2', {}, me.configured ? 'Learner access' : 'Set up the Learner'), h('p', { class: 'muted' }, me.configured ? 'Only the admin can start learning sessions and edit keys.' : 'Create the admin password. The one-time setup code was printed in the Replit console when the server started.'), me.configured ? null : code, pw, err, h('button', { class: 'btn pri', onclick: submit }, me.configured ? 'Sign in' : 'Create password'), h('a', { href: '/', 'data-link': '', class: 'muted' }, 'Back to WalSniff'))));
}
