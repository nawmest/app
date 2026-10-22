import type { FaceFrame, FaceTracker } from './face/landmarker';
import { ANCHORS, landmark } from './face/regions';
import type { HrvMetrics } from './rppg/dsp';
import { HRV_MIN_SNR, VitalsEstimator, type Vitals } from './rppg/estimator';
import { SkinSampler } from './rppg/sampler';

export type Phase = 'searching' | 'aligning' | 'scanning' | 'done';

export type GuidanceCode =
  | 'no-face'
  | 'too-far'
  | 'too-close'
  | 'off-center'
  | 'turned'
  | 'moving'
  | 'dark'
  | 'bright'
  | 'slow'
  | 'ok';

export const GUIDANCE: Record<GuidanceCode, string> = {
  'no-face': 'Look at the screen so your face fills the guide',
  'too-far': 'Move a little closer',
  'too-close': 'Move a little further away',
  'off-center': 'Center your face in the guide',
  turned: 'Face the camera straight on',
  moving: 'Hold still for an accurate reading',
  dark: 'Find brighter, even light',
  bright: 'Avoid direct light on your face',
  slow: 'Camera too slow for a reading. Close other apps',
  ok: 'Hold still and breathe normally',
};

export interface ScanResult {
  heartRate: number;
  /** Range of heart-rate estimates in the second half of the scan. */
  heartRateRange: [number, number];
  respiration: number | null;
  hrv: HrvMetrics | null;
  /** 0..1 average signal quality. */
  quality: number;
  /** Heart-rate history for the trend chart: [seconds into scan, bpm]. */
  trend: [number, number][];
  durationSec: number;
  finishedAt: Date;
}

export interface FrameState {
  phase: Phase;
  face: FaceFrame | null;
  guidance: GuidanceCode;
  /** 0..1 scan progress. */
  progress: number;
  vitals: Vitals | null;
  result: ScanResult | null;
  /** Live signal quality (0..1) and its parts. */
  quality: { signal: number; motion: number; light: number };
  /** Frames analysed per second. */
  fps: number;
}

/**
 * Below this frame rate the pulse aliases (a 78 bpm pulse sampled at 2 fps looks like 48 bpm),
 * so measuring pauses rather than produce a wrong number. Between this and 8 fps the heart-rate
 * search is limited to what the frame rate can represent.
 */
const MIN_FPS = 5;

export const SCAN_SECONDS = 30;
const ALIGN_HOLD = 0.8;

/**
 * One health scan: waits for a well-placed face, then measures for SCAN_SECONDS of usable
 * frames, keeping the user informed about anything that hurts the reading.
 */
export class ScanSession {
  phase: Phase = 'searching';
  private sampler: SkinSampler | null = null;
  private readonly estimator = new VitalsEstimator();
  private alignedSince: number | null = null;
  private scanned = 0;
  private lastT: number | null = null;
  private lastCenter: [number, number] | null = null;
  private motion = 0;
  private vitals: Vitals | null = null;
  private lastEstimate = 0;
  private result: ScanResult | null = null;
  private readonly history: { t: number; hr: number; conf: number }[] = [];
  private respHistory: number[] = [];
  private bestHrv: { hrv: HrvMetrics; snr: number } | null = null;
  private qualitySum = 0;
  private qualityN = 0;
  /** Face detection cost (ms, smoothed). When it can't keep up, detect every other frame. */
  private detectMs = 0;
  private frameNo = 0;
  private lastFace: FaceFrame | null = null;
  private lastFaceT = 0;
  private fps = 30;

  constructor(private readonly tracker: FaceTracker) {}

  /** Processes the current video frame. `t` is the frame capture time in seconds. */
  step(video: HTMLVideoElement, t: number): FrameState {
    const gap = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    const dt = Math.min(0.2, gap);
    this.lastT = t;
    if (gap > 0) this.fps += (1 / gap - this.fps) * 0.1;
    const face = this.phase === 'done' ? null : this.detect(video, t);
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!this.sampler || this.sampler.width !== Math.round(w * Math.min(1, 360 / Math.max(w, h)))) {
      this.sampler = new SkinSampler(w, h);
    }

    let guidance: GuidanceCode = 'no-face';
    let light = 0;
    let sample = null;
    if (face) {
      const top = landmark(face.points, ANCHORS.top);
      const chin = landmark(face.points, ANCHORS.chin);
      const faceH = Math.hypot(chin[0] - top[0], chin[1] - top[1]);
      const center: [number, number] = [(top[0] + chin[0]) / 2, (top[1] + chin[1]) / 2];
      if (this.lastCenter && dt > 0) {
        const speed = Math.hypot(center[0] - this.lastCenter[0], center[1] - this.lastCenter[1]) / faceH / dt;
        this.motion += (speed - this.motion) * Math.min(1, dt * 4);
      }
      this.lastCenter = center;
      sample = this.sampler.sample(video, face.points);
      const lum = sample?.luminance ?? 0;
      light = sample ? Math.max(0, Math.min(1, (lum - 40) / 50)) * (1 - Math.min(1, sample.clipped * 4)) : 0;
      const size = faceH / h;
      const off = Math.hypot(center[0] / w - 0.5, center[1] / h - 0.47);
      if (size < 0.3) guidance = 'too-far';
      else if (size > 0.85) guidance = 'too-close';
      else if (off > 0.16) guidance = 'off-center';
      else if (Math.abs(face.yaw) > 0.35 || Math.abs(face.pitch) > 0.35) guidance = 'turned';
      else if (!sample || lum < 55) guidance = 'dark';
      else if (sample.clipped > 0.2) guidance = 'bright';
      else if (this.motion > 0.25) guidance = 'moving';
      else if (this.fps < MIN_FPS) guidance = 'slow';
      else guidance = 'ok';
    } else {
      this.lastCenter = null;
    }
    const motionQ = Math.max(0, Math.min(1, 1 - (this.motion - 0.05) / 0.3));

    switch (this.phase) {
      case 'searching':
      case 'aligning':
        this.phase = face ? 'aligning' : 'searching';
        if (guidance === 'ok') {
          this.alignedSince ??= t;
          if (t - this.alignedSince >= ALIGN_HOLD) this.startScan();
        } else {
          this.alignedSince = null;
        }
        break;
      case 'scanning':
        // Small problems lower quality but don't stop the scan; losing the face pauses it.
        if (face && sample && guidance !== 'no-face' && guidance !== 'too-far' && guidance !== 'off-center' && guidance !== 'slow') {
          this.estimator.push({ t, rgb: sample.rgb, motionY: (this.lastCenter![1] / h) });
          this.scanned += dt;
          if (t - this.lastEstimate > 0.25) {
            this.lastEstimate = t;
            this.vitals = this.estimator.estimate(this.fps);
            this.record(t);
          }
          if (this.scanned >= SCAN_SECONDS && this.history.length) this.finish();
        }
        break;
      case 'done':
        break;
    }
    const signal = this.vitals?.confidence ?? 0;
    return {
      phase: this.phase,
      face,
      guidance,
      progress: Math.min(1, this.scanned / SCAN_SECONDS),
      vitals: this.phase === 'scanning' ? this.vitals : null,
      result: this.result,
      quality: { signal, motion: motionQ, light },
      fps: this.fps,
    };
  }

  /**
   * Runs the face landmarker, or (on slow devices, every other frame) reuses the previous
   * landmarks: skin colour is still sampled every frame, which is what the pulse needs.
   */
  private detect(video: HTMLVideoElement, t: number): FaceFrame | null {
    this.frameNo++;
    const reuse = this.detectMs > 28 && this.frameNo % 2 === 0 && this.lastFace && t - this.lastFaceT < 0.15;
    if (reuse) return this.lastFace;
    const a = performance.now();
    const face = this.tracker.detect(video, t * 1000);
    this.detectMs += (performance.now() - a - this.detectMs) * 0.1;
    this.lastFace = face;
    this.lastFaceT = t;
    return face;
  }

  private startScan(): void {
    this.phase = 'scanning';
    this.estimator.reset();
    this.scanned = 0;
    this.history.length = 0;
    this.respHistory = [];
    this.bestHrv = null;
    this.qualitySum = this.qualityN = 0;
  }

  private record(t: number): void {
    const v = this.vitals;
    if (!v) return;
    this.qualitySum += v.confidence;
    this.qualityN++;
    if (v.heartRate) this.history.push({ t: this.scanned, hr: v.heartRate, conf: v.confidence });
    if (v.respiration && v.respirationConfidence > 0.3) this.respHistory.push(v.respiration);
    if (v.hrv && (!this.bestHrv || v.snrDb > this.bestHrv.snr) && v.snrDb >= HRV_MIN_SNR) this.bestHrv = { hrv: v.hrv, snr: v.snrDb };
    void t;
  }

  private finish(): void {
    // Use the second half of the scan, when the estimate has settled; weight by confidence.
    const late = this.history.filter((h) => h.t >= SCAN_SECONDS / 2);
    const use = late.length >= 4 ? late : this.history;
    const wsum = use.reduce((s, h) => s + h.conf, 0) || 1;
    const hr = use.reduce((s, h) => s + h.hr * h.conf, 0) / wsum;
    const hrs = use.map((h) => h.hr).sort((a, b) => a - b);
    const resp = this.respHistory.length ? this.respHistory.slice().sort((a, b) => a - b)[this.respHistory.length >> 1] : null;
    this.result = {
      heartRate: hr,
      heartRateRange: [hrs[Math.floor(hrs.length * 0.1)], hrs[Math.floor(hrs.length * 0.9)]],
      respiration: resp,
      hrv: this.bestHrv?.hrv ?? null,
      quality: this.qualitySum / Math.max(1, this.qualityN),
      trend: this.history.map((h) => [h.t, h.hr]),
      durationSec: SCAN_SECONDS,
      finishedAt: new Date(),
    };
    this.phase = 'done';
  }
}
