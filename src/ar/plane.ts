import type { Mat3 } from '../vision/homography';
import { invert3, multiply3 } from '../vision/homography';
import type { Intrinsics } from './pose';
import {
  type Vec3,
  add,
  cross,
  dot,
  eigSym3,
  fromColumns,
  mulMM,
  mulMV,
  norm,
  normalize,
  scale,
  sub,
  transpose,
} from './linalg';

/**
 * 3D structure of the pinned surface.
 *
 * The tracker gives an accurate 2D mapping (marker coords -> image) but says nothing about depth.
 * To place 3D content correctly we need the plane's orientation in the camera frame of the lock
 * frame ("camera 0"). It comes from two sources:
 *
 *  1. Immediately, from the taps: the three pins are taken as three corners of a square lying on
 *     the surface (exactly how a QR code's finder patterns define its pose). Their perspective in
 *     the image then determines the plane's tilt.
 *  2. As the camera moves, from parallax: the homography between the lock frame and the current
 *     frame is decomposed into rotation, translation and plane normal. Estimates from frames with
 *     enough baseline are averaged, which corrects taps that were not a perfect square.
 *
 * With the normal known, the pins are back-projected to 3D and a metric (Euclidean) frame is
 * built on the plane, so the pose recovered from every later homography is geometrically exact.
 */

export interface PlaneFrame {
  /** Unit plane normal in camera-0 coordinates, pointing away from the camera (into the surface). */
  normal: Vec3;
  /** 3D pins in camera-0 coordinates (plane at n . X = 1 / (n . r1) scale, P1 at depth 1). */
  points: [Vec3, Vec3, Vec3];
}

const rayOf = (K: Intrinsics, x: number, y: number): Vec3 => [(x - K.cx) / K.f, (y - K.cy) / K.f, 1];

/** Back-projects image points onto the plane with unit normal `n`; P1 ends up at depth 1. */
export function backProject(K: Intrinsics, pins: ArrayLike<number>, n: Vec3): [Vec3, Vec3, Vec3] | null {
  const rays = [0, 1, 2].map((k) => rayOf(K, pins[2 * k], pins[2 * k + 1]));
  const d = dot(n, rays[0]); // plane: n . X = d puts P1 at depth 1
  const pts = rays.map((r) => {
    const s = dot(n, r);
    return s > 1e-6 ? scale(r, d / s) : null;
  });
  if (d <= 1e-6 || pts.some((p) => !p)) return null;
  return pts as [Vec3, Vec3, Vec3];
}

/**
 * Plane normals for which the three pins are corners of a square (right angle at P1, equal legs).
 * Returns every solution with all points in front of the camera.
 */
export function squareSolutions(K: Intrinsics, pins: ArrayLike<number>): PlaneFrame[] {
  const [r1, r2, r3] = [0, 1, 2].map((k) => rayOf(K, pins[2 * k], pins[2 * k + 1]));
  const r11 = dot(r1, r1), r12 = dot(r1, r2), r13 = dot(r1, r3);
  const r22 = dot(r2, r2), r23 = dot(r2, r3), r33 = dot(r3, r3);
  // P1 = r1, P2 = a r2, P3 = b r3. Right angle gives b(a); equal legs gives g(a) = 0.
  const bOf = (a: number) => (a * r12 - r11) / (a * r23 - r13);
  const g = (a: number) => {
    const b = bOf(a);
    return a * a * r22 - 2 * a * r12 - (b * b * r33 - 2 * b * r13);
  };
  const out: PlaneFrame[] = [];
  const steps = 600;
  const lo = Math.log(0.05);
  const hi = Math.log(20);
  let pa = Math.exp(lo);
  let pg = g(pa);
  for (let i = 1; i <= steps; i++) {
    const a = Math.exp(lo + ((hi - lo) * i) / steps);
    const ga = g(a);
    const pb = bOf(pa);
    const cb = bOf(a);
    // A sign change of g with a continuous, positive b brackets a root.
    if (Number.isFinite(pg) && Number.isFinite(ga) && pg * ga <= 0 && pb > 0 && cb > 0 && Math.abs(cb - pb) < 5) {
      let x0 = pa, x1 = a, g0 = pg;
      for (let it = 0; it < 60; it++) {
        const xm = 0.5 * (x0 + x1);
        const gm = g(xm);
        if (g0 * gm <= 0) x1 = xm;
        else {
          x0 = xm;
          g0 = gm;
        }
      }
      const ar = 0.5 * (x0 + x1);
      const br = bOf(ar);
      if (br > 0) {
        const P1 = r1;
        const P2 = scale(r2, ar);
        const P3 = scale(r3, br);
        let n = normalize(cross(sub(P2, P1), sub(P3, P1)));
        if (dot(n, P1) < 0) n = scale(n, -1);
        out.push({ normal: n, points: [P1, P2, P3] });
      }
    }
    pa = a;
    pg = ga;
  }
  return out;
}

export interface HomographyMotion {
  R: number[];
  /** Translation divided by the plane distance. */
  T: Vec3;
  /** Unit plane normal in the first camera frame, pointing away from the camera. */
  N: Vec3;
}

/**
 * Decomposes a calibrated plane-induced homography H ~ R + T N^T (camera 0 -> camera 1) into its
 * two physically valid solutions (Ma, Soatto, Kosecka & Sastry, "An Invitation to 3-D Vision",
 * Alg. 5.2). Returns [] when the motion is (close to) a pure rotation.
 */
export function decomposeHomography(Hc: ArrayLike<number>, sampleRay: Vec3): HomographyMotion[] {
  const HtH = mulMM(transpose(Hc), Hc);
  const { values, vectors } = eigSym3(HtH);
  const s2 = Math.sqrt(Math.max(values[1], 1e-30));
  let H = Array.from(Hc).map((v) => v / s2);
  // Choose the sign that keeps points in front of the camera.
  if (mulMV(H, sampleRay)[2] < 0) H = H.map((v) => -v);
  const l1 = values[0] / (s2 * s2);
  const l3 = values[2] / (s2 * s2);
  if (l1 - l3 < 1e-6) return [];
  const [v1, v2, v3] = vectors;
  const a = Math.sqrt(Math.max(0, 1 - l3));
  const b = Math.sqrt(Math.max(0, l1 - 1));
  const den = Math.sqrt(l1 - l3);
  const out: HomographyMotion[] = [];
  for (const sign of [1, -1]) {
    const u = scale(add(scale(v1, a), scale(v3, sign * b)), 1 / den);
    const U = fromColumns(v2, u, cross(v2, u));
    const Hv2 = mulMV(H, v2);
    const Hu = mulMV(H, u);
    const W = fromColumns(Hv2, Hu, cross(Hv2, Hu));
    const R = mulMM(W, transpose(U));
    let N = cross(v2, u);
    let T = mulMV(
      H.map((v, i) => v - R[i]),
      N,
    );
    // Of each (N, T) / (-N, -T) pair only the one with the plane in front of the camera is valid.
    if (N[2] < 0) {
      N = scale(N, -1);
      T = scale(T, -1);
    }
    out.push({ R, T, N: normalize(N) });
  }
  return out;
}

const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));

/** Rotates unit vector `a` towards `b` by at most fraction t of the angle between them. */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return normalize(add(scale(a, 1 - t), scale(b, t)));
}

export class PlaneEstimator {
  /** Normal currently used for rendering (moves smoothly toward the estimate). */
  normal: Vec3;
  /** Best estimate so far. */
  target: Vec3;
  /** Accumulated evidence from parallax (0 = taps only). */
  confidence = 0;
  readonly source: 'square' | 'fronto';
  private readonly initial: Vec3;
  private samples: { cands: Vec3[]; w: number }[] = [];
  private lastT: Vec3 | null = null;
  private readonly H0inv: Mat3;
  private readonly K: Intrinsics;
  private readonly Kmat: number[];
  private readonly Kinv: number[];
  private readonly pins: number[];

  /**
   * @param H0 tracker homography (marker -> image) on the lock frame
   * @param pins the three pins on the lock frame
   */
  constructor(K: Intrinsics, H0: Mat3, pins: ArrayLike<number>) {
    this.K = K;
    this.Kmat = [K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1];
    this.Kinv = [1 / K.f, 0, -K.cx / K.f, 0, 1 / K.f, -K.cy / K.f, 0, 0, 1];
    this.H0inv = invert3(H0)!;
    this.pins = Array.from(pins).slice(0, 6);
    const candidates = squareSolutions(K, pins).filter((s) => angleBetween(s.normal, [0, 0, 1]) < (78 * Math.PI) / 180);
    if (candidates.length) {
      // Perspective ambiguity: prefer the reading where the upper part of the image is farther
      // away (a table or floor seen from above), the usual way people look at a surface. Along a
      // ray r the plane n . X = d is hit at depth d / (n . r), so "farther" means smaller n . r.
      // Seen almost straight on, a square also fits a few ~20-30 degree tilts; take the straight
      // reading then.
      const up = normalize(rayOf(K, K.cx, 0));
      candidates.sort((p, q) => dot(p.normal, up) - dot(q.normal, up));
      const straight = candidates.find((c) => angleBetween(c.normal, [0, 0, 1]) < (8 * Math.PI) / 180);
      this.normal = (straight ?? candidates[0]).normal;
      this.source = 'square';
    } else {
      this.normal = [0, 0, 1];
      this.source = 'fronto';
    }
    this.initial = this.target = this.normal;
  }

  /** Feeds the current marker -> image homography. Returns true when the estimate changed. */
  observe(Ht: Mat3): boolean {
    // Image-0 -> image-t homography, then calibrated.
    const G = multiply3(Ht, this.H0inv);
    const Gc = mulMM(mulMM(this.Kinv, G), this.Kmat);
    const ray = rayOf(this.K, this.pins[0], this.pins[1]);
    const sols = decomposeHomography(Gc, ray);
    if (sols.length !== 2) return false;
    const baseline = norm(sols[0].T);
    // Too little parallax: the normal is not observable yet.
    if (baseline < 0.06) return false;
    // Only keep solutions that leave the pins in front of the camera.
    const cands = sols
      .filter((s) => [0, 1, 2].every((k) => dot(s.N, rayOf(this.K, this.pins[2 * k], this.pins[2 * k + 1])) > 0))
      .map((s) => s.N);
    if (!cands.length) return false;
    // Skip near-duplicate viewpoints so the samples cover different camera positions.
    const T = sols[0].T;
    if (this.lastT && norm(sub(T, this.lastT)) < 0.02) return false;
    this.lastT = T;
    this.samples.push({ cands, w: Math.min(baseline, 0.4) });
    if (this.samples.length > 80) this.samples.shift();
    this.reestimate();
    return true;
  }

  /**
   * Every sample offers two candidate normals: the true one, which is the same in every sample,
   * and a false one that moves with the camera. Pick the direction most samples agree on and
   * average the agreeing candidates.
   */
  private reestimate(): void {
    const near = (a: Vec3, b: Vec3, cosTol: number) => Math.exp(-(1 - dot(a, b)) / (1 - cosTol));
    const k3 = Math.cos((3 * Math.PI) / 180);
    const priorW = this.source === 'square' ? 0.3 : 0.05;
    let best: Vec3 = this.initial;
    let bestScore = -1;
    const all = [this.initial, ...this.samples.flatMap((s) => s.cands)];
    for (const c of all) {
      let score = priorW * near(c, this.initial, k3);
      for (const s of this.samples) {
        let m = 0;
        for (const d of s.cands) m = Math.max(m, near(c, d, k3));
        score += s.w * m;
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const cos6 = Math.cos((6 * Math.PI) / 180);
    let sum: Vec3 = [0, 0, 0];
    let support = 0;
    for (const s of this.samples) {
      const d = s.cands.reduce((p, q) => (dot(q, best) > dot(p, best) ? q : p));
      if (dot(d, best) < cos6) continue;
      sum = add(sum, scale(d, s.w));
      support += s.w;
    }
    this.confidence = support;
    if (support <= 0) return;
    // Blend from the tap-based guess to the measured normal as evidence accumulates; once a few
    // well-separated views agree, the measurement alone is used.
    const full = this.source === 'square' ? 1 : 0.3;
    this.target = slerp(this.initial, normalize(sum), Math.min(1, support / full));
  }

  /** Moves the rendering normal toward the estimate; call once per frame. */
  step(amount = 0.15): void {
    this.normal = slerp(this.normal, this.target, amount);
  }

  /** Angle (degrees) between the surface and the image plane, for display. */
  get tiltDegrees(): number {
    return (angleBetween(this.normal, [0, 0, 1]) * 180) / Math.PI;
  }

  /**
   * Metric marker -> image homography for the current frame. The metric frame has its origin at
   * P1, x towards P2, y towards P3 (in the plane), z into the surface, and unit = side of the square.
   */
  metricHomography(Ht: Mat3): Mat3 | null {
    const pts = backProject(this.K, this.pins, this.normal);
    if (!pts) return null;
    const [P1, P2, P3] = pts;
    const e1 = normalize(sub(P2, P1));
    const d3 = sub(P3, P1);
    const e2 = normalize(sub(d3, scale(e1, dot(d3, e1))));
    const side = 0.5 * (norm(sub(P2, P1)) + Math.abs(dot(d3, e2)));
    // Metric coords -> camera-0 -> image-0.
    const M0 = mulMM(this.Kmat, fromColumns(scale(e1, side), scale(e2, side), P1));
    // image-0 -> marker -> image-t.
    const H = multiply3(multiply3(Ht, this.H0inv), Float64Array.from(M0));
    return H;
  }
}
