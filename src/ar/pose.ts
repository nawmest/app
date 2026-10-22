import type { Mat3 } from '../vision/homography';

export interface Intrinsics {
  /** Focal length in pixels (square pixels assumed). */
  f: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Typical phone main cameras have a ~65-70 degree field of view across the long side of the
 * sensor. Without calibration data this is a good default.
 */
export function estimateIntrinsics(width: number, height: number, longSideFovDeg = 67): Intrinsics {
  const long = Math.max(width, height);
  const f = long / 2 / Math.tan(((longSideFovDeg / 2) * Math.PI) / 180);
  return { f, cx: width / 2, cy: height / 2, width, height };
}

export interface Pose {
  /** Rotation, column-major 3x3 (columns = marker X, Y, Z axes in camera coordinates). */
  R: Float64Array;
  /** Translation of the marker origin in camera coordinates (marker side length = 1). */
  t: Float64Array;
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Decomposes a marker -> image homography into a camera-space pose (OpenCV convention:
 * x right, y down, z forward). H ~ K [r1 r2 t].
 */
export function poseFromHomography(H: Mat3, K: Intrinsics): Pose | null {
  // M = K^-1 H
  const m = new Array<number>(9);
  for (let c = 0; c < 3; c++) {
    const h0 = H[c];
    const h1 = H[3 + c];
    const h2 = H[6 + c];
    m[c] = (h0 - K.cx * h2) / K.f;
    m[3 + c] = (h1 - K.cy * h2) / K.f;
    m[6 + c] = h2;
  }
  const m1 = [m[0], m[3], m[6]];
  const m2 = [m[1], m[4], m[7]];
  const m3 = [m[2], m[5], m[8]];
  const n1 = Math.hypot(m1[0], m1[1], m1[2]);
  const n2 = Math.hypot(m2[0], m2[1], m2[2]);
  if (!(n1 > 1e-12 && n2 > 1e-12)) return null;
  let lambda = 2 / (n1 + n2);
  // The marker must be in front of the camera.
  if (m3[2] * lambda < 0) lambda = -lambda;
  const a = normalize(m1.map((v) => v * lambda));
  const b = normalize(m2.map((v) => v * lambda));
  const c = normalize(cross(a, b));
  // Symmetric orthonormalization of the two in-plane axes around their bisector.
  const p = normalize([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  const q = normalize(cross(c, p));
  const s = Math.SQRT1_2;
  const r1 = [(p[0] - q[0]) * s, (p[1] - q[1]) * s, (p[2] - q[2]) * s];
  const r2 = [(p[0] + q[0]) * s, (p[1] + q[1]) * s, (p[2] + q[2]) * s];
  const r3 = cross(r1, r2);
  const t = m3.map((v) => v * lambda);
  if (!t.every(Number.isFinite) || t[2] <= 0) return null;
  return {
    R: Float64Array.from([...r1, ...r2, ...r3]),
    t: Float64Array.from(t),
  };
}

/** Projects a marker-space 3D point with the pose (for tests and debugging). */
export function projectPoint(pose: Pose, K: Intrinsics, X: number, Y: number, Z: number): [number, number] {
  const { R, t } = pose;
  const x = R[0] * X + R[3] * Y + R[6] * Z + t[0];
  const y = R[1] * X + R[4] * Y + R[7] * Z + t[1];
  const z = R[2] * X + R[5] * Y + R[8] * Z + t[2];
  return [K.cx + (K.f * x) / z, K.cy + (K.f * y) / z];
}
