import './style.css';
import { CameraError, FrameGrabber, startCamera } from './camera';
import { startDemo, startVideoFile } from './sources';
import { XRController, xrSupported } from './xr';
import { ANIMATIONS } from './ar/animations';
import { OneEuroFilter } from './ar/filter';
import { PlaneEstimator } from './ar/plane';
import { type Intrinsics, type Pose, estimateIntrinsics, poseFromHomography, projectPoint } from './ar/pose';
import { ARScene } from './ar/scene';
import { snapToCorner } from './vision/features';
import { type Mat3, homographyFrom4, markerQuad } from './vision/homography';
import { type Pyramid, buildPyramid } from './vision/image';
import { trackPoints } from './vision/lk';
import { PlanarTracker } from './vision/tracker';

type Mode = 'intro' | 'pinning' | 'tracking' | 'xr';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const glCanvas = $<HTMLCanvasElement>('gl');
const overlay = $<HTMLCanvasElement>('overlay');
const octx = overlay.getContext('2d')!;
const statusEl = $('status');
const statusText = $('status-text');
const hint = $('hint');
const toastEl = $('toast');
const chips = $('animations');
const btnUndo = $<HTMLButtonElement>('btn-undo');
const btnReset = $<HTMLButtonElement>('btn-reset');
const btnBase = $<HTMLButtonElement>('btn-base');
const btnDebug = $<HTMLButtonElement>('btn-debug');

const PIN_NAMES = ['top-left', 'top-right', 'bottom-left'];
const PYRAMID_LEVELS = 4;
const SNAP_RADIUS = 14;

let mode: Mode = 'intro';
let grabber: FrameGrabber | null = null;
let K: Intrinsics | null = null;
let scene: ARScene | null = null;
let prevPyr: Pyramid | null = null;
let curPyr: Pyramid | null = null;
/** Pinned points in processing pixels (flat xy) and whether each one is currently tracked. */
let pins: number[] = [];
let pinOk: boolean[] = [];
/** Where each pin was actually tapped, relative to its snapped (trackable) position. */
let tapOffsets: number[] = [];
let tracker = new PlanarTracker();
// Smooths jitter when the phone is still, follows quickly when it moves.
const cornerFilter = new OneEuroFilter(8, 1.5, 0.04);
let smoothH: Mat3 | null = null;
/** 3D structure of the pinned surface (tilt from the taps, refined from parallax). */
let plane: PlaneEstimator | null = null;
let lastPose: Pose | null = null;
let showDebug = false;
let showBase = true;
let lastFrameKey = -1;
let frameCounter = 0;
let toastTimer = 0;
/** Display rectangle of the video frame in CSS pixels. */
const view = { left: 0, top: 0, width: 1, height: 1 };

/* ------------------------------------------------------------------ UI helpers */

function toast(message: string, warn = false, ms = 2600): void {
  toastEl.textContent = message;
  toastEl.classList.toggle('warn', warn);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
}

function setStatus(state: 'pinning' | 'tracking' | 'weak' | 'lost', text: string): void {
  statusEl.dataset.state = state;
  if (statusText.textContent !== text) statusText.textContent = text;
}

function setHint(html: string): void {
  if (hint.innerHTML !== html) hint.innerHTML = html;
}

function updatePinningUI(): void {
  const n = pins.length / 2;
  setStatus('pinning', `Pin ${Math.min(n + 1, 3)} of 3`);
  setHint(
    n < 3
      ? `Tap the <b>${PIN_NAMES[n]}</b> corner (point ${n + 1}) of a square on the surface`
      : 'Locking…',
  );
  btnUndo.disabled = n === 0;
}

function buildChips(): void {
  chips.innerHTML = '';
  for (const a of ANIMATIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.id = a.id;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<span class="icon">${a.icon}</span><span>${a.label}</span>`;
    b.addEventListener('click', () => selectAnimation(a.id));
    chips.appendChild(b);
  }
}

function selectAnimation(id: string): void {
  scene?.setAnimation(id);
  for (const c of chips.querySelectorAll<HTMLButtonElement>('.chip')) {
    c.setAttribute('aria-pressed', String(c.dataset.id === id));
  }
  try {
    localStorage.setItem('tripoint.animation', id);
  } catch {
    /* storage unavailable */
  }
}

function savedAnimation(): string {
  try {
    const id = localStorage.getItem('tripoint.animation');
    if (id && ANIMATIONS.some((a) => a.id === id)) return id;
  } catch {
    /* storage unavailable */
  }
  return ANIMATIONS[0].id;
}

/* ------------------------------------------------------------------ Layout */

/** Fits the video frame to cover the screen and aligns the GL and overlay canvases with it. */
function layout(): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const s = Math.max(W / vw, H / vh);
  view.width = vw * s;
  view.height = vh * s;
  view.left = (W - view.width) / 2;
  view.top = (H - view.height) / 2;
  for (const el of [video, glCanvas, overlay]) {
    el.style.left = `${view.left}px`;
    el.style.top = `${view.top}px`;
    el.style.width = `${view.width}px`;
    el.style.height = `${view.height}px`;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(view.width * dpr);
  overlay.height = Math.round(view.height * dpr);

  // (Re)create the processing pipeline when the camera resolution or orientation changes.
  if (!grabber || Math.abs(grabber.width / grabber.height - vw / vh) > 0.01) {
    grabber = new FrameGrabber(vw, vh);
    K = estimateIntrinsics(grabber.width, grabber.height);
    prevPyr = curPyr = null;
    if (mode === 'tracking' || pins.length) resetPins();
  }
  if (scene && K) scene.configure(view.width, view.height, K);
}

/* ------------------------------------------------------------------ Pinning */

function resetPins(): void {
  pins = [];
  pinOk = [];
  tapOffsets = [];
  tracker.reset();
  cornerFilter.reset();
  smoothH = null;
  plane = null;
  lastPose = null;
  scene?.setPose(null);
  mode = 'pinning';
  chips.hidden = true;
  updatePinningUI();
}

function undoPin(): void {
  if (mode === 'tracking') {
    // Go back to editing the third pin.
    tracker.reset();
    scene?.setPose(null);
    smoothH = null;
    plane = null;
    lastPose = null;
    cornerFilter.reset();
    mode = 'pinning';
    chips.hidden = true;
  }
  pins.splice(-2, 2);
  tapOffsets.splice(-2, 2);
  pinOk.pop();
  updatePinningUI();
}

function onTap(ev: PointerEvent): void {
  if (mode !== 'pinning' || !grabber || !curPyr) return;
  const x = ((ev.clientX - view.left) / view.width) * grabber.width;
  const y = ((ev.clientY - view.top) / view.height) * grabber.height;
  if (x < 0 || y < 0 || x >= grabber.width || y >= grabber.height) return;
  const snap = snapToCorner(curPyr[0], x, y, SNAP_RADIUS, 4);
  pins.push(snap.x, snap.y);
  tapOffsets.push(x - snap.x, y - snap.y);
  pinOk.push(true);
  if (!snap.snapped) toast('Low detail at that spot — pick a sharp corner or high-contrast spot for steadier tracking.', true);
  if (navigator.vibrate) navigator.vibrate(15);
  if (pins.length === 6) lock();
  else updatePinningUI();
}

function lock(): void {
  if (!curPyr || !K) return;
  const [x1, y1, x2, y2, x3, y3] = pins;
  const cross = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const minSide = Math.min(Math.hypot(x2 - x1, y2 - y1), Math.hypot(x3 - x1, y3 - y1), Math.hypot(x3 - x2, y3 - y2));
  const diag = Math.hypot(K.width, K.height);
  if (minSide < diag * 0.06 || Math.abs(cross) < (diag * diag) * 0.004) {
    toast('Those points are too close together or in a line — spread them out.', true);
    pins.splice(-2, 2);
    tapOffsets.splice(-2, 2);
    pinOk.pop();
    updatePinningUI();
    return;
  }
  // QR finder patterns are symmetric across the diagonal: if the pins were placed
  // counter-clockwise, swap 2 and 3 so the marker is never mirrored (content stays above the surface).
  if (cross < 0) {
    [pins[2], pins[3], pins[4], pins[5]] = [pins[4], pins[5], pins[2], pins[3]];
    [tapOffsets[2], tapOffsets[3], tapOffsets[4], tapOffsets[5]] = [tapOffsets[4], tapOffsets[5], tapOffsets[2], tapOffsets[3]];
  }
  tracker = new PlanarTracker();
  if (!tracker.init(curPyr, pins)) {
    toast('Could not lock onto these points. Try again.', true);
    resetPins();
    return;
  }
  if (tracker.cur.length / 2 < 12) {
    toast('Not much texture around the points — tracking may be unstable.', true, 3500);
  }
  // The square is where the user tapped; the snapped pins only serve tracking.
  const taps = pins.map((v, i) => v + tapOffsets[i]);
  plane = new PlaneEstimator(K, tracker.H!, taps);
  mode = 'tracking';
  cornerFilter.reset();
  smoothH = null;
  chips.hidden = false;
  btnUndo.disabled = false;
  if (!scene?.currentAnimation) selectAnimation(savedAnimation());
  scene?.playScan();
  if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
}

/* ------------------------------------------------------------------ Frame loop */

function processFrame(time: number): void {
  if (!grabber || !K) return;
  const gray = grabber.grab(video);
  // Show exactly the frame being analysed, so the content never lags behind the image.
  scene?.markVideoFrame();
  // Ping-pong the two pyramid buffers.
  const target = prevPyr;
  prevPyr = curPyr;
  curPyr = buildPyramid(gray, PYRAMID_LEVELS, target ?? undefined);
  frameCounter++;
  if (!prevPyr) return;

  if (mode === 'pinning' && pins.length) {
    // Keep the already placed pins glued to the scene while the user aims for the next one.
    const res = trackPoints(prevPyr, curPyr, Float32Array.from(pins), { maxFBError: 2 });
    for (let i = 0; i < pins.length / 2; i++) {
      pinOk[i] = res.status[i] === 1;
      if (pinOk[i]) {
        pins[2 * i] = res.points[2 * i];
        pins[2 * i + 1] = res.points[2 * i + 1];
      }
    }
  } else if (mode === 'tracking') {
    const res = tracker.update(prevPyr, curPyr);
    if (res.relocalized) {
      cornerFilter.reset();
      scene?.playScan();
      toast('Target found again');
    }
    if (res.H) {
      plane?.observe(res.H);
      const quad = markerQuad(res.H);
      const f = cornerFilter.filter(quad, time / 1000);
      smoothH = homographyFrom4([0, 0, 1, 0, 1, 1, 0, 1], f) ?? res.H;
    }
    plane?.step();
    const depthReady = (plane?.confidence ?? 0) >= 1;
    if (res.state === 'lost') {
      smoothH = null;
      setStatus('lost', 'Target lost');
      setHint('Point the camera back at the pinned spot… or tap <b>Reset</b> to pin again');
    } else if (!res.H || res.inliers < 15) {
      setStatus('weak', `Tracking (weak · ${res.inliers} pts)`);
      setHint('');
    } else {
      setStatus('tracking', depthReady ? `Tracking · 3D locked · ${res.inliers} pts` : `Tracking · ${res.inliers} pts`);
      setHint(depthReady ? '' : 'Move the phone slowly to the side around the spot to measure depth');
    }
    const Hm = smoothH && plane ? plane.metricHomography(smoothH) : null;
    lastPose = Hm ? poseFromHomography(Hm, K) : null;
    scene?.setPose(lastPose);
  }
}

function drawOverlay(): void {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);
  if (!grabber || mode === 'intro') return;
  const sx = w / grabber.width;
  const sy = h / grabber.height;
  const dpr = w / view.width;

  if (showDebug && mode === 'tracking') {
    octx.fillStyle = 'rgba(255, 220, 80, 0.9)';
    for (let k = 0; k < tracker.cur.length; k += 2) {
      octx.fillRect(tracker.cur[k] * sx - 2 * dpr, tracker.cur[k + 1] * sy - 2 * dpr, 4 * dpr, 4 * dpr);
    }
    if (smoothH) {
      const q = markerQuad(smoothH);
      octx.strokeStyle = 'rgba(255, 220, 80, 0.9)';
      octx.lineWidth = 2 * dpr;
      octx.beginPath();
      for (let k = 0; k < 4; k++) octx.lineTo(q[2 * k] * sx, q[2 * k + 1] * sy);
      octx.closePath();
      octx.stroke();
    }
  }

  if (mode !== 'pinning') return;
  const n = pins.length / 2;
  // Dashed outline of the virtual QR code as it is being defined.
  if (n >= 2) {
    octx.save();
    octx.setLineDash([8 * dpr, 6 * dpr]);
    octx.strokeStyle = 'rgba(0, 255, 213, 0.8)';
    octx.lineWidth = 2 * dpr;
    octx.beginPath();
    octx.moveTo(pins[0] * sx, pins[1] * sy);
    octx.lineTo(pins[2] * sx, pins[3] * sy);
    octx.stroke();
    octx.restore();
  }
  for (let i = 0; i < n; i++) {
    const x = pins[2 * i] * sx;
    const y = pins[2 * i + 1] * sy;
    const r = 16 * dpr;
    const color = pinOk[i] ? '#00ffd5' : '#ff5c7a';
    // Finder-pattern style marker.
    octx.lineWidth = 3 * dpr;
    octx.strokeStyle = color;
    octx.strokeRect(x - r, y - r, 2 * r, 2 * r);
    octx.fillStyle = color;
    octx.fillRect(x - r * 0.45, y - r * 0.45, r * 0.9, r * 0.9);
    octx.fillStyle = 'rgba(0,0,0,0.6)';
    octx.beginPath();
    octx.arc(x + r + 8 * dpr, y - r - 6 * dpr, 10 * dpr, 0, Math.PI * 2);
    octx.fill();
    octx.fillStyle = '#fff';
    octx.font = `bold ${12 * dpr}px system-ui, sans-serif`;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillText(String(i + 1), x + r + 8 * dpr, y - r - 6 * dpr);
  }
}

function loop(time: number): void {
  requestAnimationFrame(loop);
  // In WebXR the session drives rendering (XRController).
  if (mode === 'intro' || mode === 'xr' || video.readyState < 2) return;
  // Only process frames the camera actually delivered.
  const key = video.currentTime;
  if (key !== lastFrameKey) {
    lastFrameKey = key;
    processFrame(time);
  }
  drawOverlay();
  scene?.render();
}

/* ------------------------------------------------------------------ Boot */

type Source = { kind: 'camera' } | { kind: 'file'; file: File } | { kind: 'demo' };

async function start(source: Source): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-start');
  const err = $('intro-error');
  const buttons = document.querySelectorAll<HTMLButtonElement>('#intro button');
  buttons.forEach((b) => (b.disabled = true));
  const label = btn.textContent;
  if (source.kind === 'camera') btn.textContent = 'Starting camera…';
  err.hidden = true;
  try {
    if (source.kind === 'camera') await startCamera(video);
    else if (source.kind === 'file') await startVideoFile(video, source.file);
    else await startDemo(video);
  } catch (e) {
    err.textContent = e instanceof CameraError || e instanceof Error ? e.message : String(e);
    if (source.kind === 'camera') err.textContent += ' You can still record or pick a video, or try the demo scene.';
    err.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
    btn.textContent = label;
    return;
  }
  try {
    scene ??= new ARScene(glCanvas);
    scene.setVideo(video);
  } catch {
    toast('WebGL is not available, so animations are turned off.', true, 5000);
  }
  $('intro').hidden = true;
  $('hud').hidden = false;
  $('controls').hidden = false;
  layout();
  resetPins();
  if (source.kind === 'file') toast('The video loops. Pin 3 points while it plays.', false, 3500);
}

let xr: XRController | null = null;

async function startXR(): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-xr');
  const err = $('intro-error');
  err.hidden = true;
  btn.disabled = true;
  try {
    scene ??= new ARScene(glCanvas);
    xr ??= new XRController(scene, $('ui'), {
      status: setStatus,
      hint: setHint,
      toast: (m, warn) => toast(m, warn),
      locked: () => {
        chips.hidden = false;
        if (!scene?.currentAnimation) selectAnimation(savedAnimation());
        scene?.playScan();
      },
      unlocked: () => (chips.hidden = true),
      ended: () => {
        mode = 'intro';
        chips.hidden = true;
        $('hud').hidden = true;
        $('controls').hidden = true;
        $('intro').hidden = false;
      },
    });
    mode = 'xr';
    $('intro').hidden = true;
    $('hud').hidden = false;
    $('controls').hidden = false;
    btnDebug.hidden = true;
    await xr.start();
  } catch (e) {
    mode = 'intro';
    $('intro').hidden = false;
    $('hud').hidden = true;
    $('controls').hidden = true;
    err.textContent = `Could not start AR (${e instanceof Error ? e.message : String(e)}). Use camera tracking instead.`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function init(): void {
  buildChips();
  $('btn-start').addEventListener('click', () => start({ kind: 'camera' }));
  $('btn-demo').addEventListener('click', () => start({ kind: 'demo' }));
  const fileInput = $<HTMLInputElement>('file-video');
  $('btn-video').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) start({ kind: 'file', file });
  });
  overlay.addEventListener('pointerdown', onTap);
  btnUndo.addEventListener('click', () => (mode === 'xr' ? xr?.undo() : undoPin()));
  btnReset.addEventListener('click', () => (mode === 'xr' ? xr?.reset() : resetPins()));
  // Taps on the controls must not also place pins in WebXR.
  $('controls').addEventListener('beforexrselect', (e) => e.preventDefault());
  $('btn-xr').addEventListener('click', startXR);
  xrSupported().then((ok) => {
    if (!ok) return;
    // Real world tracking is available: make it the default, keep camera tracking as a fallback.
    $('btn-xr').hidden = false;
    const cam = $<HTMLButtonElement>('btn-start');
    cam.className = 'secondary wide';
    cam.textContent = 'Use camera tracking instead';
  });
  btnBase.addEventListener('click', () => {
    showBase = !showBase;
    btnBase.classList.toggle('on', showBase);
    btnBase.setAttribute('aria-pressed', String(showBase));
    scene?.setBaseVisible(showBase);
  });
  btnDebug.addEventListener('click', () => {
    showDebug = !showDebug;
    btnDebug.classList.toggle('on', showDebug);
    btnDebug.setAttribute('aria-pressed', String(showDebug));
  });
  window.addEventListener('resize', layout);
  video.addEventListener('resize', layout);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mode !== 'intro') video.play().catch(() => {});
  });
  requestAnimationFrame(loop);

  // Small read-only hook for automated end-to-end tests.
  (window as unknown as { __tripoint: unknown }).__tripoint = {
    get mode() {
      return mode;
    },
    get pins() {
      return pins.slice();
    },
    get trackerState() {
      return tracker.state;
    },
    get quad() {
      return smoothH ? markerQuad(smoothH) : null;
    },
    /** Projects a point of the virtual code's 3D frame (a, b along the edges, h above it). */
    project(a: number, b: number, h: number) {
      return lastPose && K ? projectPoint(lastPose, K, a, b, -h) : null;
    },
    get plane() {
      return plane ? { normal: plane.normal, confidence: plane.confidence, source: plane.source } : null;
    },
    get processingSize() {
      return grabber ? [grabber.width, grabber.height] : null;
    },
    get view() {
      return { ...view };
    },
    get debug() {
      return { features: tracker.cur.length / 2, inliers: tracker.lastInliers, state: tracker.state };
    },
    get frames() {
      return frameCounter;
    },
  };
}

init();
