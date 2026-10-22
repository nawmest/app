import './style.css';
import { CameraError, startFrontCamera, stopCamera } from './camera';
import { createFaceTracker, type FaceTracker } from './face/landmarker';
import { GUIDANCE, SCAN_SECONDS, ScanSession, type FrameState } from './scan';
import { FxRenderer } from './ui/fx';
import { drawTrend, heartRateStatus, renderResults, summaryText } from './ui/results';
import { WaveRenderer } from './ui/wave';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = { intro: $('intro'), loading: $('loading'), scan: $('scan'), results: $('results') };
const video = $<HTMLVideoElement>('video');
const fx = new FxRenderer($<HTMLCanvasElement>('fx'));
const wave = new WaveRenderer($<HTMLCanvasElement>('wave'));
const cards = { hr: $('card-hr'), resp: $('card-resp'), hrv: $('card-hrv') };
const ui = {
  hrValue: $('hr-value'),
  hrSub: $('hr-sub'),
  respValue: $('resp-value'),
  respSub: $('resp-sub'),
  hrvValue: $('hrv-value'),
  hrvSub: $('hrv-sub'),
  guidance: $('guidance'),
  phase: $('phase-text'),
  timer: $('timer'),
  quality: $('quality'),
  qualityText: $('quality-text'),
};

let tracker: FaceTracker | null = null;
let session: ScanSession | null = null;
let state: FrameState | null = null;
let running = false;
let scanStartedAt: number | null = null;
let okSince: number | null = null;
let lastRender = 0;
// Heartbeat clock for the animations: phase-locked to the detected beats at the measured rate.
let beatAnchor = 0;
let beatPeriod = 0;
let nextBeat = 0;
let pulse = 0;
let shownHr = 0;

/**
 * Performance governor: measuring always comes first. When frames take too long, drop the glass
 * blur and mesh detail, then animate at half rate; restore detail when there is headroom again.
 */
const perf = { processMs: 0, renderMs: 0, tier: 0, checkedAt: 0, calmSince: 0, frame: 0 };
function governPerformance(now: number): void {
  if (now - perf.checkedAt < 1) return;
  perf.checkedAt = now;
  const slow = perf.renderMs > 18 || perf.processMs > 60;
  const calm = perf.renderMs < 8 && perf.processMs < 30;
  if (slow && perf.tier < 2) {
    perf.tier++;
    perf.calmSince = now;
  } else if (calm && perf.tier > 0 && now - perf.calmSince > 4) {
    perf.tier--;
    perf.calmSince = now;
  } else if (!calm) perf.calmSince = now;
  document.body.classList.toggle('lite', perf.tier > 0);
  fx.detail = perf.tier;
}

function show(name: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

function showError(message: string): void {
  const err = $('intro-error');
  err.textContent = message;
  err.hidden = false;
  show('intro');
}

async function startScan(): Promise<void> {
  $('intro-error').hidden = true;
  $<HTMLButtonElement>('btn-start').disabled = true;
  show('loading');
  $('loading-text').textContent = 'Starting the front camera…';
  try {
    await startFrontCamera(video);
  } catch (e) {
    $<HTMLButtonElement>('btn-start').disabled = false;
    showError(e instanceof CameraError ? e.message : `Could not start the camera (${e}).`);
    return;
  }
  try {
    $('loading-text').textContent = 'Preparing the face model…';
    tracker ??= await createFaceTracker();
  } catch (e) {
    stopCamera(video);
    $<HTMLButtonElement>('btn-start').disabled = false;
    showError(`The face model could not be loaded (${e instanceof Error ? e.message : e}). Check your connection and try again.`);
    return;
  }
  $<HTMLButtonElement>('btn-start').disabled = false;
  session = new ScanSession(tracker);
  state = null;
  scanStartedAt = null;
  okSince = null;
  beatPeriod = 0;
  shownHr = 0;
  resetCards();
  show('scan');
  running = true;
  wave.resize();
  scheduleFrame();
  lastRender = performance.now();
  requestAnimationFrame(render);
}

function stopScan(): void {
  running = false;
  stopCamera(video);
}

/* ------------------------------------------------------------------ measurement (per video frame) */

let lastVideoTime = -1;
function scheduleFrame(): void {
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame);
  else requestAnimationFrame(onAnimationFrame);
}

function onVideoFrame(now: number, meta: VideoFrameCallbackMetadata): void {
  if (!running) return;
  process((meta.captureTime ?? meta.expectedDisplayTime ?? now) / 1000);
}

/** Fallback without requestVideoFrameCallback: process each new frame once. */
function onAnimationFrame(now: number): void {
  if (!running) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    process(now / 1000);
  } else scheduleFrame();
}

function process(t: number): void {
  if (!session) return;
  const started = performance.now();
  state = session.step(video, t);
  perf.processMs += (performance.now() - started - perf.processMs) * 0.1;
  if (state.phase === 'scanning') scanStartedAt ??= performance.now() / 1000;
  if (state.phase === 'done' && state.result) {
    finish();
    return;
  }
  scheduleFrame();
}

/* ------------------------------------------------------------------ display (per animation frame) */

function render(ts: number): void {
  if (!running) return;
  requestAnimationFrame(render);
  governPerformance(ts / 1000);
  if (perf.tier === 2 && perf.frame++ % 2) return;
  const dt = Math.min(0.1, (ts - lastRender) / 1000);
  lastRender = ts;
  const now = ts / 1000;
  const s = state;
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const rect = screens.scan.getBoundingClientRect();
  fx.resize(rect.width, rect.height, vw, vh);

  // Heartbeat clock.
  const v = s?.vitals ?? null;
  if (v?.heartRate && v.confidence > 0.3) {
    beatPeriod = 60 / v.heartRate;
    const last = v.beats[v.beats.length - 1];
    if (last && last > beatAnchor) beatAnchor = last;
    if (nextBeat < now - beatPeriod) nextBeat = beatAnchor + Math.ceil((now - beatAnchor) / beatPeriod) * beatPeriod;
    if (now >= nextBeat) {
      nextBeat += beatPeriod;
      pulse = 1;
      cards.hr.classList.remove('beat');
      void cards.hr.offsetWidth;
      cards.hr.classList.add('beat');
    }
  }
  pulse *= Math.exp(-dt / 0.22);

  const phase = s?.phase ?? 'searching';
  const guidance = s?.guidance ?? 'no-face';
  if (phase === 'aligning' && guidance === 'ok') okSince ??= now;
  else okSince = null;

  const sizes = [cards.hr, cards.resp, cards.hrv].map((c) => ({ w: c.offsetWidth, h: c.offsetHeight }));
  const layout = fx.render(
    {
      now,
      dt,
      phase,
      guidance,
      progress: s?.progress ?? 0,
      face: s?.face ?? null,
      pulse,
      scanAge: scanStartedAt === null ? null : now - scanStartedAt,
      alignHold: okSince === null ? 0 : Math.min(1, (now - okSince) / 0.8),
    },
    sizes,
  );
  for (const key of ['hr', 'resp', 'hrv'] as const) {
    const el = cards[key];
    const visible = !!layout?.visible && phase === 'scanning';
    el.classList.toggle('show', visible);
    if (layout) el.style.transform = `translate3d(${layout[key].x.toFixed(1)}px, ${layout[key].y.toFixed(1)}px, 0)`;
  }
  updateCards(v, dt);
  updateHud(s, now);
  wave.render(phase === 'scanning' ? v : null, now, dt);
  perf.renderMs += (performance.now() - ts - perf.renderMs) * 0.1;
}

function resetCards(): void {
  ui.hrValue.textContent = '—';
  ui.hrSub.textContent = 'Finding pulse…';
  ui.respValue.textContent = '—';
  ui.respSub.textContent = 'Needs ~15 s';
  ui.hrvValue.textContent = '—';
  ui.hrvSub.textContent = 'Hold very still';
}

function updateCards(v: FrameState['vitals'], dt: number): void {
  if (!v) return;
  if (v.heartRate && v.confidence > 0.3) {
    shownHr = shownHr ? shownHr + (v.heartRate - shownHr) * Math.min(1, dt * 4) : v.heartRate;
    ui.hrValue.textContent = String(Math.round(shownHr));
    ui.hrSub.textContent = v.confidence > 0.55 ? heartRateStatus(shownHr).short : 'Settling…';
  }
  if (v.respiration) {
    ui.respValue.textContent = String(Math.round(v.respiration));
    ui.respSub.textContent = 'breaths/min';
  } else if ((session?.phase ?? '') === 'scanning') {
    ui.respSub.textContent = (state?.progress ?? 0) * SCAN_SECONDS < 15 ? 'Needs ~15 s' : 'Measuring…';
  }
  if (v.hrv) {
    ui.hrvValue.textContent = String(Math.round(v.hrv.rmssd));
    ui.hrvSub.textContent = 'RMSSD';
  }
}

function updateHud(s: FrameState | null, now: number): void {
  const phase = s?.phase ?? 'searching';
  const g = s?.guidance ?? 'no-face';
  let text = '';
  let warn = false;
  if (phase === 'searching' || phase === 'aligning') {
    text = GUIDANCE[g];
    warn = g !== 'ok';
  } else if (phase === 'scanning' && g !== 'ok') {
    text = GUIDANCE[g];
    warn = true;
  }
  if (ui.guidance.textContent !== text) ui.guidance.textContent = text;
  ui.guidance.classList.toggle('warn', warn);
  const dots = '.'.repeat(1 + (Math.floor(now * 2) % 3));
  ui.phase.textContent =
    phase === 'scanning' ? `Measuring${dots}` : phase === 'aligning' && g === 'ok' ? 'Hold still' : phase === 'aligning' ? 'Align your face' : 'Looking for your face';
  ui.timer.textContent = phase === 'scanning' ? `${Math.max(0, Math.ceil(SCAN_SECONDS * (1 - (s?.progress ?? 0))))} s left` : '';
  const q = s ? (phase === 'scanning' ? 0.6 * s.quality.signal + 0.2 * s.quality.motion + 0.2 * s.quality.light : 0.5 * s.quality.motion + 0.5 * s.quality.light) : 0;
  const level = s?.face ? Math.max(1, Math.round(q * 4)) : 0;
  ui.quality.dataset.level = String(level);
  ui.qualityText.textContent = ['No face', 'Weak', 'Fair', 'Good', 'Great'][level];
}

/* ------------------------------------------------------------------ results */

function finish(): void {
  const result = state?.result;
  stopScan();
  if (!result) return;
  const body = $('results-body');
  const trend = renderResults(body, result);
  show('results');
  requestAnimationFrame(() => drawTrend(trend, result.trend, result.durationSec));
  $('btn-again').addEventListener('click', startScan);
  $('btn-copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(summaryText(result));
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy not available';
    }
  });
}

/* ------------------------------------------------------------------ wiring */

$('btn-start').addEventListener('click', startScan);
$('btn-close').addEventListener('click', () => {
  stopScan();
  show('intro');
});
document.addEventListener('visibilitychange', () => {
  // A hidden page stops delivering frames; a broken signal would give a wrong reading.
  if (document.hidden && running) {
    stopScan();
    showError('The scan stopped because the app went to the background. Start again when ready.');
  }
});
window.addEventListener('resize', () => wave.resize());

// Read-only hook for automated end-to-end tests.
(window as unknown as { __pulse: unknown }).__pulse = {
  get state() {
    const s = state;
    return s && {
      phase: s.phase,
      guidance: s.guidance,
      progress: s.progress,
      face: !!s.face,
      hr: s.vitals?.heartRate ?? null,
      confidence: s.vitals?.confidence ?? null,
      respiration: s.vitals?.respiration ?? null,
      hrv: s.vitals?.hrv?.rmssd ?? null,
      fps: s.fps,
      perfTier: perf.tier,
      result: s.result,
    };
  },
};
