/**
 * Particle field — pequenas partículas de luz flutuando no fundo.
 * Leve e discreto: respeita prefers-reduced-motion e para em telas pequenas.
 */
(function () {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;
  if (window.innerWidth < 768) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'particles-canvas';
  canvas.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function makeParticle(randomY) {
    const r = 1 + Math.random() * 2;
    return {
      x: Math.random() * W,
      y: randomY ? Math.random() * H : H + r,
      r,
      vy: -(0.15 + Math.random() * 0.35),
      vx: (Math.random() - 0.5) * 0.2,
      o: 0.15 + Math.random() * 0.4,
      tw: Math.random() * Math.PI * 2,
      tws: 0.005 + Math.random() * 0.01,
      hue: Math.random() > 0.7 ? '168, 85, 247' : '16, 184, 245'
    };
  }

  function seed() {
    const count = Math.min(70, Math.floor(W / 18));
    particles = [];
    for (let i = 0; i < count; i++) particles.push(makeParticle(true));
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.tw += p.tws;
      if (p.y < -10) { particles[i] = makeParticle(false); continue; }
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
      const alpha = p.o * (0.6 + 0.4 * Math.sin(p.tw));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.hue}, ${alpha})`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  resize();
  seed();
  window.addEventListener('resize', () => { resize(); seed(); });
  tick();
})();
