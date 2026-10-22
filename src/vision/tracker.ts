import { detectCorners } from './features';
import {
  type Mat3,
  affineFromTriangle,
  applyH,
  invert3,
  isConvexQuad,
  markerQuad,
  multiply3,
  polygonArea,
  ransac,
} from './homography';
import { type Pyramid, copyPyramid } from './image';
import { trackPoints } from './lk';
import { type Template, cutTemplate, matchTemplate } from './ncc';

/**
 * Planar tracker for the "virtual QR code".
 *
 * The three pinned points define a marker coordinate system: P1 = (0,0), P2 = (1,0), P3 = (0,1),
 * exactly like the three finder patterns of a QR code; the fourth corner (1,1) is implied.
 * Instead of tracking only those three pixels (fragile), the tracker follows every good corner in
 * and around the marker area with pyramidal Lucas-Kanade and robustly fits the marker -> image
 * homography with RANSAC every frame. The three pins are then simply re-projected through it.
 */

export type TrackerState = 'idle' | 'tracking' | 'lost';

export interface TrackerOptions {
  pyramidLevels: number;
  maxFeatures: number;
  minFeatureDistance: number;
  /** Marker-space margin around the unit square where features are collected. */
  regionMargin: number;
  ransacThreshold: number;
  /** Frames of consecutive failure before switching to the relocalization search. */
  maxFailedFrames: number;
  minInliers: number;
  /** Minimum fraction of the current features that must agree with the pose for a frame to count. */
  minSupport: number;
  /** RNG used by RANSAC (injectable for deterministic tests). */
  random: () => number;
}

export const DEFAULT_TRACKER: TrackerOptions = {
  pyramidLevels: 4,
  maxFeatures: 90,
  minFeatureDistance: 9,
  regionMargin: 0.45,
  ransacThreshold: 2.5,
  maxFailedFrames: 8,
  minInliers: 6,
  minSupport: 0.35,
  random: Math.random,
};

export interface TrackerFrameResult {
  state: TrackerState;
  /** Marker (unit square) -> image homography, valid when state === 'tracking'. */
  H: Mat3 | null;
  inliers: number;
  features: number;
  /** True when this frame recovered from the lost state. */
  relocalized: boolean;
}

interface AnchorTemplates {
  coarse: Template[];
  fine: Template[];
  /** Pin positions when the templates were captured (level-0 pixels). */
  pins: number[];
  /** Marker -> image homography at capture time. */
  H: Mat3;
}

const COARSE_LEVEL = 2;

export class PlanarTracker {
  readonly opt: TrackerOptions;
  state: TrackerState = 'idle';
  H: Mat3 | null = null;
  /** Current feature positions in image pixels, flat xy. */
  cur: number[] = [];
  /** Feature positions in marker coordinates, flat uv. */
  ref: number[] = [];
  lastInliers = 0;
  private prevH: Mat3 | null = null;
  private failed = 0;
  private frame = 0;
  /** Anchor appearance for relocalization: [at lock time, most recent good view]. */
  private templates: (AnchorTemplates | null)[] = [null, null];
  private lastCapture = 0;
  /** Copy of the last frame with a good pose, used as the tracking source while failing. */
  private keyPyr: Pyramid | null = null;

  constructor(options: Partial<TrackerOptions> = {}) {
    this.opt = { ...DEFAULT_TRACKER, ...options };
  }

  reset(): void {
    this.state = 'idle';
    this.H = this.prevH = null;
    this.cur = [];
    this.ref = [];
    this.templates = [null, null];
    this.failed = 0;
    this.lastInliers = 0;
  }

  /**
   * Starts tracking from three pinned points (flat [x1,y1,x2,y2,x3,y3]) on the given frame.
   * `initialH` may provide a full marker -> image homography that maps the unit triangle onto the
   * pins (used when relocalizing, to keep the perspective known from before).
   */
  init(pyr: Pyramid, pins: ArrayLike<number>, relocalizing = false, initialH?: Mat3): boolean {
    const H = initialH ?? affineFromTriangle(pins);
    if (!invert3(H)) return false;
    this.H = H;
    this.prevH = null;
    this.cur = [];
    this.ref = [];
    this.failed = 0;
    this.state = 'tracking';
    // The pins themselves are good corners (they were snapped) and anchor the fit.
    for (let k = 0; k < 3; k++) {
      this.cur.push(pins[2 * k], pins[2 * k + 1]);
    }
    this.ref.push(0, 0, 1, 0, 0, 1);
    this.replenish(pyr, this.opt.maxFeatures);
    this.lastInliers = this.cur.length >> 1;
    this.lastCapture = this.frame;
    if (!relocalizing) {
      this.templates = [this.captureTemplates(pyr, pins, H), null];
    }
    return true;
  }

  private captureTemplates(pyr: Pyramid, pins: ArrayLike<number>, H: Mat3): AnchorTemplates | null {
    const coarse: Template[] = [];
    const fine: Template[] = [];
    const s = 1 / (1 << COARSE_LEVEL);
    for (let k = 0; k < 3; k++) {
      const c = cutTemplate(pyr[COARSE_LEVEL], pins[2 * k] * s, pins[2 * k + 1] * s, 6);
      const f = cutTemplate(pyr[0], pins[2 * k], pins[2 * k + 1], 8);
      if (!c || !f) return null;
      coarse.push(c);
      fine.push(f);
    }
    return { coarse, fine, pins: Array.from(pins).slice(0, 6), H: Float64Array.from(H) };
  }

  /** Region (image polygon) where features are collected. */
  private regionPolygon(H: Mat3): number[] {
    const m = this.opt.regionMargin;
    const out: number[] = [];
    for (const [u, v] of [[-m, -m], [1 + m, -m], [1 + m, 1 + m], [-m, 1 + m]]) out.push(...applyH(H, u, v));
    return out;
  }

  private replenish(pyr: Pyramid, want: number): void {
    const H = this.H;
    if (!H) return;
    const Hinv = invert3(H);
    if (!Hinv) return;
    const poly = this.regionPolygon(H);
    if (!isConvexQuad(poly)) return;
    const level = pyr[0];
    const border = 10;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      x0 = Math.min(x0, poly[2 * k]);
      x1 = Math.max(x1, poly[2 * k]);
      y0 = Math.min(y0, poly[2 * k + 1]);
      y1 = Math.max(y1, poly[2 * k + 1]);
    }
    x0 = Math.max(border, x0);
    y0 = Math.max(border, y0);
    x1 = Math.min(level.width - border, x1);
    y1 = Math.min(level.height - border, y1);
    if (x1 <= x0 || y1 <= y0) return;
    const orient = Math.sign(polygonArea(poly));
    const inside = (x: number, y: number) => {
      for (let k = 0; k < 4; k++) {
        const ax = poly[2 * k], ay = poly[2 * k + 1];
        const bx = poly[2 * ((k + 1) % 4)], by = poly[2 * ((k + 1) % 4) + 1];
        if (Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax)) === -orient) return false;
      }
      return true;
    };
    const pts = detectCorners(level, { x0, y0, x1, y1 }, {
      maxCorners: want,
      quality: 0.01,
      minResponse: 2,
      minDistance: this.opt.minFeatureDistance,
      accept: inside,
      existing: this.cur,
    });
    for (let k = 0; k < pts.length; k += 2) {
      const [u, v] = applyH(Hinv, pts[k], pts[k + 1]);
      this.cur.push(pts[k], pts[k + 1]);
      this.ref.push(u, v);
    }
  }

  /** Processes a new frame. `prev` must be the pyramid of the previous processed frame. */
  update(prev: Pyramid, next: Pyramid): TrackerFrameResult {
    this.frame++;
    if (this.state === 'idle') return this.result(false);
    if (this.state === 'lost') return this.tryRelocalize(next);

    const count = this.cur.length >> 1;
    const pts = Float32Array.from(this.cur);
    // Constant-velocity prediction from the last two poses helps with fast motion.
    let guess: Float32Array | undefined;
    if (this.H && this.prevH) {
      const prevInv = invert3(this.prevH);
      if (prevInv) {
        const G = multiply3(this.H, prevInv);
        guess = new Float32Array(pts.length);
        for (let i = 0; i < count; i++) {
          const [px, py] = applyH(G, pts[2 * i], pts[2 * i + 1]);
          const dx = (px - pts[2 * i]) * 0.7;
          const dy = (py - pts[2 * i + 1]) * 0.7;
          if (Number.isFinite(dx) && Number.isFinite(dy) && Math.abs(dx) < 60 && Math.abs(dy) < 60) {
            guess[2 * i] = dx;
            guess[2 * i + 1] = dy;
          }
        }
      }
    }
    // While failing, keep matching against the last frame where the pose was good: a cut to an
    // unrelated (possibly static) view must not be "tracked" just because it is self-consistent.
    const source = this.failed > 0 && this.keyPyr ? this.keyPyr : prev;
    const tracked = trackPoints(source, next, pts, {}, guess);
    const src: number[] = [];
    const dst: number[] = [];
    const keep: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!tracked.status[i]) continue;
      src.push(this.ref[2 * i], this.ref[2 * i + 1]);
      dst.push(tracked.points[2 * i], tracked.points[2 * i + 1]);
      keep.push(i);
    }

    let fit = this.fitModel(src, dst);
    // A sudden collapse of the supporting features means the view changed abruptly (occlusion, the
    // camera whipped away): do not let the few survivors drag the marker onto something else.
    if (fit && count >= 20 && fit.inlierCount < this.opt.minSupport * count) fit = null;
    if (!fit) {
      // Freeze the features at their last good positions and remember that frame.
      if (this.failed === 0) this.keyPyr = copyPyramid(prev, this.keyPyr);
      this.failed++;
      this.prevH = null;
      if (this.failed >= this.opt.maxFailedFrames) this.state = 'lost';
      return this.result(false);
    }

    this.failed = 0;
    this.prevH = this.H;
    this.H = fit.H;
    this.lastInliers = fit.inlierCount;
    const cur: number[] = [];
    const ref: number[] = [];
    for (let k = 0; k < keep.length; k++) {
      if (!fit.inliers[k]) continue;
      cur.push(dst[2 * k], dst[2 * k + 1]);
      ref.push(src[2 * k], src[2 * k + 1]);
    }
    this.cur = cur;
    this.ref = ref;
    const n = cur.length >> 1;
    if (n < this.opt.maxFeatures * 0.7 && this.frame % 3 === 0) {
      this.replenish(next, this.opt.maxFeatures - n);
    }
    // Remember how the pins look from the current viewpoint: after losing the target, the user
    // most likely comes back to about where it was lost.
    if (this.frame - this.lastCapture >= 8 && fit.inlierCount >= 20) {
      this.lastCapture = this.frame;
      const pins = [...applyH(fit.H, 0, 0), ...applyH(fit.H, 1, 0), ...applyH(fit.H, 0, 1)];
      const recent = this.captureTemplates(next, pins, fit.H);
      if (recent) this.templates[1] = recent;
    }
    return this.result(false);
  }

  private fitModel(src: number[], dst: number[]) {
    const n = src.length >> 1;
    const thr = this.opt.ransacThreshold;
    let fit = n >= 8 ? ransac(src, dst, { threshold: thr, model: 'homography', random: this.opt.random }) : null;
    if (fit && fit.inlierCount < Math.max(this.opt.minInliers, 0.3 * n)) fit = null;
    if (!fit && n >= 4) {
      // Few features: an affine model is far better conditioned.
      fit = ransac(src, dst, { threshold: thr * 1.5, model: 'affine', random: this.opt.random });
      if (fit && fit.inlierCount < Math.max(4, 0.4 * n)) fit = null;
    }
    if (!fit) return null;
    if (!this.plausible(fit.H)) return null;
    return fit;
  }

  /** Rejects degenerate or wildly jumping poses. */
  private plausible(H: Mat3): boolean {
    const q = markerQuad(H);
    if (!isConvexQuad(q)) return false;
    // Marker must stay in front of the camera: w > 0 at every corner.
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      if (H[6] * u + H[7] * v + H[8] <= 0) return false;
    }
    const area = Math.abs(polygonArea(q));
    if (area < 16) return false;
    if (this.H) {
      const prevArea = Math.abs(polygonArea(markerQuad(this.H)));
      const ratio = area / prevArea;
      if (ratio < 0.5 || ratio > 2) return false;
    }
    return true;
  }

  private tryRelocalize(next: Pyramid): TrackerFrameResult {
    if (this.frame % 3 !== 0) return this.result(false);
    for (const t of [this.templates[1], this.templates[0]]) {
      if (!t) continue;
      const found = findPins(next, t);
      if (!found || !similarTriangle(t.pins, found)) continue;
      // Carry the perspective of the capture-time pose over to the found pins.
      const correction = invert3(affineFromTriangle(t.pins));
      const H = correction ? multiply3(multiply3(affineFromTriangle(found), correction), t.H) : undefined;
      if (!this.init(next, found, true, H)) continue;
      return this.result(true);
    }
    return this.result(false);
  }

  private result(relocalized: boolean): TrackerFrameResult {
    return {
      state: this.state,
      H: this.state === 'tracking' && this.failed === 0 ? this.H : null,
      inliers: this.lastInliers,
      features: this.cur.length >> 1,
      relocalized,
    };
  }
}

/** Coarse-to-fine NCC search for the three pin templates. */
function findPins(pyr: Pyramid, t: AnchorTemplates): number[] | null {
  const s = 1 << COARSE_LEVEL;
  const found: number[] = [];
  for (let k = 0; k < 3; k++) {
    const coarse = matchTemplate(pyr[COARSE_LEVEL], t.coarse[k]);
    if (coarse.score < 0.7) return null;
    const cx = coarse.x * s;
    const cy = coarse.y * s;
    const r = s + 2;
    const fine = matchTemplate(pyr[0], t.fine[k], { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r });
    if (fine.score < 0.75) return null;
    found.push(fine.x, fine.y);
  }
  return found;
}

/** Checks that two pin triangles have the same orientation and roughly the same shape/size. */
export function similarTriangle(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const side = (p: ArrayLike<number>, i: number, j: number) =>
    Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]);
  const cross = (p: ArrayLike<number>) =>
    (p[2] - p[0]) * (p[5] - p[1]) - (p[3] - p[1]) * (p[4] - p[0]);
  if (Math.sign(cross(a)) !== Math.sign(cross(b))) return false;
  const a12 = side(a, 0, 1), a13 = side(a, 0, 2), a23 = side(a, 1, 2);
  const b12 = side(b, 0, 1), b13 = side(b, 0, 2), b23 = side(b, 1, 2);
  const scale = (b12 + b13 + b23) / (a12 + a13 + a23);
  if (!(scale > 0.4 && scale < 2.5)) return false;
  const within = (x: number, y: number) => {
    const r = x / (y * scale);
    return r > 0.6 && r < 1.6;
  };
  return within(b12, a12) && within(b13, a13) && within(b23, a23);
}
