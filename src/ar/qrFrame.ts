import { type Vec3, cross, dot, norm, normalize, scale, sub, add } from './linalg';

export interface QRFrame {
  /** Column-major 4x4 matrix: content space (centred, y up, unit = side) -> world. */
  matrix: number[];
  /** Side of the virtual QR code in world units (metres in WebXR). */
  side: number;
  /** True when P2 and P3 had to be swapped to keep the frame right-handed. */
  swapped: boolean;
}

/**
 * Builds the virtual QR code from three points on a surface with known "up" direction.
 * Content space matches the animations: origin at the centre of the code, x towards P2,
 * y up out of the surface, z towards P3, one unit = one side of the code.
 */
export function qrFrameFromPoints(p1: Vec3, p2: Vec3, p3: Vec3, up: Vec3, allowSwap = true): QRFrame | null {
  const e1 = normalize(sub(p2, p1));
  let n = sub(up, scale(e1, dot(up, e1)));
  if (norm(n) < 1e-6) return null;
  n = normalize(n);
  const d3 = sub(p3, p1);
  const inPlane = sub(sub(d3, scale(e1, dot(d3, e1))), scale(n, dot(d3, n)));
  if (norm(inPlane) < 1e-6 || norm(sub(p2, p1)) < 1e-6) return null;
  const e2 = normalize(inPlane);
  if (dot(cross(e1, n), e2) < 0) {
    // Pins placed the other way round: the code is symmetric across its diagonal, so swap 2 and 3.
    if (!allowSwap) return null;
    const f = qrFrameFromPoints(p1, p3, p2, up, false);
    return f && { ...f, swapped: true };
  }
  const side = 0.5 * (norm(sub(p2, p1)) + Math.abs(dot(d3, e2)));
  const c = add(p1, scale(add(e1, e2), 0.5 * side));
  const x = scale(e1, side);
  const y = scale(n, side);
  const z = scale(e2, side);
  return { matrix: [...x, 0, ...y, 0, ...z, 0, ...c, 1], side, swapped: false };
}
