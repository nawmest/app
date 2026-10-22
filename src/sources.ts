/**
 * Alternative video sources for places where the live camera is unavailable (embedded previews,
 * desktop browsers without a camera): a recorded/picked video file, or a synthetic demo scene.
 */

/** Plays a local video file (on phones the picker can record one with the camera). */
export async function startVideoFile(video: HTMLVideoElement, file: File): Promise<void> {
  const old = video.src;
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('This video format cannot be played here. Try an MP4 file.')), {
      once: true,
    });
  });
  await video.play();
}

/** Procedural poster with plenty of corners to track. */
function makePoster(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#e9dcc4');
  grad.addColorStop(1, '#b9c8d6');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 240; i++) {
    g.fillStyle = `hsl(${Math.floor(rnd() * 360)},${45 + rnd() * 50}%,${18 + rnd() * 60}%)`;
    const x = rnd() * size;
    const y = rnd() * size;
    const s = 8 + rnd() * 70;
    if (rnd() < 0.5) g.fillRect(x, y, s, s * (0.3 + rnd()));
    else {
      g.beginPath();
      g.arc(x, y, s / 2, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = '#111';
  g.font = 'bold 72px system-ui, sans-serif';
  g.fillText('TRIPOINT', 120, 430);
  g.strokeStyle = '#111';
  g.lineWidth = 10;
  g.strokeRect(5, 5, size - 10, size - 10);
  return c;
}

let demoTimer = 0;

/** A virtual camera filming a poster on a table while the "hand" slowly moves. */
export async function startDemo(video: HTMLVideoElement): Promise<void> {
  const W = 720;
  const H = 1280;
  const P = 800;
  const poster = makePoster(P);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const start = performance.now();
  const draw = () => {
    const t = (performance.now() - start) / 1000;
    const angle = 0.25 * Math.sin(t * 0.3);
    const scale = 0.85 + 0.08 * Math.sin(t * 0.22);
    const tx = W / 2 + 50 * Math.sin(t * 0.4);
    const ty = H / 2 + 60 * Math.cos(t * 0.27);
    const c = Math.cos(angle) * scale;
    const s = Math.sin(angle) * scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#4a3b2e';
    ctx.fillRect(0, 0, W, H);
    // Wood-ish table stripes so the background has some texture too.
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = 0; y < H; y += 46) ctx.fillRect(0, y, W, 3);
    ctx.setTransform(c, s, -s, c, tx - (c * P) / 2 + (s * P) / 2, ty - (s * P) / 2 - (c * P) / 2);
    ctx.drawImage(poster, 0, 0);
  };
  window.clearInterval(demoTimer);
  draw();
  demoTimer = window.setInterval(draw, 1000 / 30);
  video.removeAttribute('src');
  video.srcObject = canvas.captureStream(30);
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  }
}
