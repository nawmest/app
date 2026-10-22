// Injected before the app loads: replaces getUserMedia with a synthetic front camera filming a
// rendered head (e2e/fixtures/head.png) whose skin carries a pulse of known rate. Configure with
// window.__fakeCamConfig = { bpm, breathsPerMin, sway } before the page loads.
(() => {
  const cfg = Object.assign({ bpm: 72, breathsPerMin: 15, sway: 1, rrJitterMs: 25, amplitude: 0.012 }, window.__fakeCamConfig || {});
  // Phone-like stream: 480x640 at 15 fps keeps this test's own load low.
  const W = 480;
  const H = 640;
  const FPS = 15;
  const head = new Image();
  head.src = window.__fakeCamHead || '/e2e/fixtures/head.png';

  // Beat times with a little beat-to-beat variability (seeded).
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const beats = [0];
  while (beats[beats.length - 1] < 600) beats.push(beats[beats.length - 1] + 60 / cfg.bpm + (cfg.rrJitterMs / 1000) * (rnd() * 2 - 1) * 1.7);
  const shape = (ph) => (ph < 0.15 ? Math.sin((ph / 0.15) * (Math.PI / 2)) ** 2 : Math.exp(-(ph - 0.15) / 0.22) + 0.25 * Math.exp(-(((ph - 0.5) / 0.1) ** 2)));
  let bi = 0;
  const pulseAt = (t) => {
    while (bi < beats.length - 2 && beats[bi + 1] <= t) bi++;
    while (bi > 0 && beats[bi] > t) bi--;
    return shape((t - beats[bi]) / (beats[bi + 1] - beats[bi]));
  };

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const skin = document.createElement('canvas');
  skin.width = W;
  skin.height = H;
  const sctx = skin.getContext('2d');
  const t0 = performance.now();
  const state = { t: 0, present: true };

  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    state.t = t;
    state.draws = (state.draws || 0) + 1;
    const p = pulseAt(t);
    // More blood absorbs more light, most of all in green (blood volume pulse signature).
    const a = cfg.amplitude * p;
    const mul = [1 - a * 0.33, 1 - a * 0.77, 1 - a * 0.53].map((v) => Math.round(v * 255));
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(head, 0, 0, W, H);
    sctx.globalCompositeOperation = 'multiply';
    sctx.fillStyle = `rgb(${mul[0]},${mul[1]},${mul[2]})`;
    sctx.fillRect(0, 0, W, H);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(head, 0, 0, W, H);

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#c9ced3');
    bg.addColorStop(1, '#8c949b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (state.present) {
      // Natural sway and breathing motion.
      const breath = Math.sin((2 * Math.PI * cfg.breathsPerMin * t) / 60);
      const dx = cfg.sway * (4 * Math.sin(t * 0.7) + 2 * Math.sin(t * 1.9));
      const dy = cfg.sway * (3 * Math.sin(t * 0.5)) + 2.5 * breath;
      ctx.save();
      ctx.translate(W / 2 + dx, H / 2 + dy);
      ctx.rotate(cfg.sway * 0.015 * Math.sin(t * 0.6));
      ctx.drawImage(skin, -W / 2, -H / 2);
      ctx.restore();
    }
  };

  window.__fakeCam = { config: cfg, state, width: W, height: H };
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => {
    await head.decode();
    setInterval(draw, 1000 / FPS);
    return canvas.captureStream(FPS);
  };
})();
