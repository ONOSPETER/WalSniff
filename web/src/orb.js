// Memory lattice: a 3D point-sphere projected on canvas. Nodes flash when a "memory" is written; rings are sniff waves.
export function mountOrb(canvas, { density = 130, getTheme = () => 'dark' } = {}) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, raf = 0, visible = true, mx = 0, my = 0, tx = 0, ty = 0;
  const pts = Array.from({ length: density }, (_, i) => {
    const y = 1 - (i / (density - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    return { x: Math.cos(th) * r, y, z: Math.sin(th) * r, flash: 0 };
  });
  const rings = [];
  const resize = () => { dpr = Math.min(2, devicePixelRatio || 1); const b = canvas.getBoundingClientRect(); W = b.width; H = b.height; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  const move = (e) => { const b = canvas.getBoundingClientRect(); tx = ((e.clientX - b.left) / b.width - 0.5) * 2; ty = ((e.clientY - b.top) / b.height - 0.5) * 2; };
  addEventListener('pointermove', move, { passive: true });
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf && !reduce) loop(); }); io.observe(canvas);
  let t0 = performance.now(), lastFlash = 0;
  function frame(now) {
    const t = (now - t0) / 1000; mx += (tx - mx) * 0.04; my += (ty - my) * 0.04;
    ctx.clearRect(0, 0, W, H);
    const dark = getTheme() === 'dark';
    const R = Math.min(W * 0.34, H * 0.46), cx = W * 0.5, cy = H * 0.5;
    const ay = t * 0.18 + mx * 0.5, ax = -0.35 + my * 0.3, sa = Math.sin(ay), ca = Math.cos(ay), sx = Math.sin(ax), cxx = Math.cos(ax);
    if (now - lastFlash > 700) { pts[(Math.random() * pts.length) | 0].flash = 1; lastFlash = now; }
    const proj = pts.map((p) => {
      const x1 = p.x * ca + p.z * sa, z1 = -p.x * sa + p.z * ca, y2 = p.y * cxx - z1 * sx, z2 = p.y * sx + z1 * cxx;
      const k = 1 / (1.9 - z2 * 0.55);
      return { sx: cx + x1 * R * k * 1.9, sy: cy + y2 * R * k * 1.9, z: z2, k, p };
    });
    ctx.lineWidth = 1;
    for (let i = 0; i < proj.length; i++) for (let j = i + 1; j < proj.length; j++) {
      const a = proj[i], b = proj[j]; const dx = a.p.x - b.p.x, dy = a.p.y - b.p.y, dz = a.p.z - b.p.z; const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 0.2) { const al = (1 - d2 / 0.2) * 0.35 * ((a.z + b.z + 2) / 4 + 0.15); ctx.strokeStyle = dark ? `rgba(120,255,200,${al})` : `rgba(6,110,70,${al * 1.1})`; ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke(); }
    }
    for (const q of proj.sort((a, b) => a.z - b.z)) {
      const f = q.p.flash; q.p.flash = Math.max(0, f - 0.012);
      const r = (1.4 + (q.z + 1) * 1.1) * q.k * 1.7 + f * 4;
      if (f > 0.97) rings.push({ x: q.sx, y: q.sy, r: 4, a: 0.9 });
      ctx.fillStyle = f > 0.02 ? `rgba(243,239,219,${0.5 + f * 0.5})` : dark ? `rgba(80,240,175,${0.3 + (q.z + 1) * 0.3})` : `rgba(5,130,80,${0.35 + (q.z + 1) * 0.3})`;
      ctx.shadowColor = f > 0.02 ? '#F3EFDB' : '#38EAA3'; ctx.shadowBlur = f > 0.02 ? 16 : dark ? 6 : 0;
      ctx.beginPath(); ctx.arc(q.sx, q.sy, r, 0, 6.283); ctx.fill();
    }
    ctx.shadowBlur = 0;
    for (let i = rings.length - 1; i >= 0; i--) { const g = rings[i]; g.r += 1.1; g.a -= 0.012; if (g.a <= 0) { rings.splice(i, 1); continue; } ctx.strokeStyle = dark ? `rgba(120,255,200,${g.a * 0.6})` : `rgba(6,120,75,${g.a * 0.6})`; ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 6.283); ctx.stroke(); }
    // sniff waves from the centre
    for (let k = 0; k < 3; k++) { const ph = ((t * 0.25 + k / 3) % 1); ctx.strokeStyle = dark ? `rgba(120,255,200,${(1 - ph) * 0.14})` : `rgba(6,120,75,${(1 - ph) * 0.14})`; ctx.beginPath(); ctx.arc(cx, cy, R * (0.9 + ph * 1.5), 0, 6.283); ctx.stroke(); }
  }
  function loop(now = performance.now()) { raf = 0; if (!visible || document.hidden) return; frame(now); raf = requestAnimationFrame(loop); }
  if (reduce) frame(performance.now() + 2000); else loop();
  const vis = () => { if (!document.hidden && visible && !raf && !reduce) loop(); }; document.addEventListener('visibilitychange', vis);
  return { flash() { pts[(Math.random() * pts.length) | 0].flash = 1; }, destroy() { cancelAnimationFrame(raf); raf = 0; visible = false; ro.disconnect(); io.disconnect(); removeEventListener('pointermove', move); document.removeEventListener('visibilitychange', vis); } };
}
