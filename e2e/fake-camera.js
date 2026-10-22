// Injected before the app loads: replaces getUserMedia with a synthetic rear camera that films a
// textured poster moving in front of it. Ground truth is exposed on window.__fakeCam so the test
// can compare the tracker output with the real position of the poster.
(() => {
  const W = 720;
  const H = 1280;
  const P = 800; // poster size (px)

  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const makePoster = (hueBase, label) => {
    const c = document.createElement('canvas');
    c.width = c.height = P;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, P, P);
    grad.addColorStop(0, `hsl(${hueBase},40%,70%)`);
    grad.addColorStop(1, `hsl(${hueBase + 60},40%,45%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, P, P);
    for (let i = 0; i < 220; i++) {
      g.fillStyle = `hsl(${Math.floor(rnd() * 360)},${50 + rnd() * 50}%,${15 + rnd() * 70}%)`;
      const x = rnd() * P;
      const y = rnd() * P;
      const s = 8 + rnd() * 70;
      if (rnd() < 0.5) g.fillRect(x, y, s, s * (0.3 + rnd()));
      else {
        g.beginPath();
        g.arc(x, y, s / 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (label) {
      g.fillStyle = '#111';
      g.font = 'bold 64px sans-serif';
      g.fillText(label, 120, 420);
    }
    return c;
  };

  const poster = makePoster(200, 'TRIPOINT');
  const other = makePoster(20, ''); // a different scene used to simulate looking away

  const state = {
    frozen: false,
    away: false,
    t: 0,
    matrix: [1, 0, 0, 1, 0, 0], // canvas affine a, b, c, d, e, f (poster px -> frame px)
  };

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  let last = performance.now();

  const pose = (t) => {
    const angle = 0.35 * Math.sin(t * 0.7);
    const scale = 0.85 + 0.12 * Math.sin(t * 0.5);
    const tx = W / 2 + 70 * Math.sin(t * 0.9);
    const ty = H / 2 + 90 * Math.cos(t * 0.6);
    const c = Math.cos(angle) * scale;
    const s = Math.sin(angle) * scale;
    // M = T(tx,ty) R S T(-P/2,-P/2)
    return [c, s, -s, c, tx - (c * P) / 2 + (s * P) / 2, ty - (s * P) / 2 - (c * P) / 2];
  };

  const draw = () => {
    const now = performance.now();
    if (!state.frozen) state.t += (now - last) / 1000;
    last = now;
    state.matrix = pose(state.t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, W, H);
    if (state.away) {
      ctx.drawImage(other, -40, 0, W + 80, H);
    } else {
      ctx.setTransform(...state.matrix);
      ctx.drawImage(poster, 0, 0);
    }
    // Sensor noise so the image is never perfectly static.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let i = 0; i < 40; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    requestAnimationFrame(draw);
  };

  window.__fakeCam = {
    state,
    width: W,
    height: H,
    /** Poster px -> frame px with the current ground-truth transform. */
    project(u, v) {
      const [a, b, c, d, e, f] = state.matrix;
      return [a * u + c * v + e, b * u + d * v + f];
    },
    /** Frame px -> poster px. */
    unproject(x, y) {
      const [a, b, c, d, e, f] = state.matrix;
      const det = a * d - b * c;
      const X = x - e;
      const Y = y - f;
      return [(d * X - c * Y) / det, (-b * X + a * Y) / det];
    },
  };

  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => {
    requestAnimationFrame(draw);
    return canvas.captureStream(30);
  };
})();
