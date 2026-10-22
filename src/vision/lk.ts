import { type Pyramid, sample } from './image';

export interface LKOptions {
  /** Half size of the integration window (window = 2r+1). */
  halfWindow: number;
  maxIterations: number;
  epsilon: number;
  /** Minimum eigenvalue of the normalized structure tensor; below this the point is untrackable. */
  minEigen: number;
  /** Max forward-backward error (level-0 pixels) for a track to be accepted. Infinity disables the check. */
  maxFBError: number;
  /** Coarsest pyramid level used (levels above it are ignored). */
  maxLevel: number;
  /**
   * Minimum normalized cross-correlation between the patch before and after tracking. Rejects
   * points that "converged" onto unrelated content after occlusions or abrupt view changes.
   */
  minNCC: number;
}

export const DEFAULT_LK: LKOptions = {
  halfWindow: 7,
  maxIterations: 12,
  epsilon: 0.02,
  minEigen: 0.3,
  maxFBError: 1.0,
  maxLevel: 2,
  minNCC: 0.7,
};

/**
 * Bilinearly samples a (2r+1)^2 window centred at (cx, cy) into `out`. All window pixels share the
 * same fractional offset, so the weights are computed once; the clamped slow path is only taken
 * when the window touches the image border.
 */
function sampleWindow(img: Float32Array, w: number, h: number, cx: number, cy: number, r: number, out: Float32Array): void {
  const fx = Math.floor(cx);
  const fy = Math.floor(cy);
  if (fx - r < 0 || fy - r < 0 || fx + r + 1 > w - 1 || fy + r + 1 > h - 1) {
    let k = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out[k++] = sample(img, w, h, cx + dx, cy + dy);
    return;
  }
  const ax = cx - fx;
  const ay = cy - fy;
  const w00 = (1 - ax) * (1 - ay);
  const w01 = ax * (1 - ay);
  const w10 = (1 - ax) * ay;
  const w11 = ax * ay;
  let k = 0;
  for (let dy = -r; dy <= r; dy++) {
    let i = (fy + dy) * w + fx - r;
    for (let dx = -r; dx <= r; dx++, i++) {
      out[k++] = w00 * img[i] + w01 * img[i + 1] + w10 * img[i + w] + w11 * img[i + w + 1];
    }
  }
}

function ncc(a: Float32Array, b: Float32Array, n: number): number {
  let sa = 0;
  let sb = 0;
  for (let k = 0; k < n; k++) {
    sa += a[k];
    sb += b[k];
  }
  const ma = sa / n;
  const mb = sb / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let k = 0; k < n; k++) {
    const da = a[k] - ma;
    const db = b[k] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

let scratch = { n: 0, iw: new Float32Array(0), ixw: new Float32Array(0), iyw: new Float32Array(0), jw: new Float32Array(0) };

/**
 * Pyramidal Lucas-Kanade (Bouguet) for a single point. Returns the new position
 * or null when the point could not be tracked.
 */
function trackOne(
  prev: Pyramid,
  next: Pyramid,
  px: number,
  py: number,
  opt: LKOptions,
  guessX = 0,
  guessY = 0,
): [number, number] | null {
  const r = opt.halfWindow;
  const n = (2 * r + 1) * (2 * r + 1);
  if (scratch.n !== n) {
    scratch = { n, iw: new Float32Array(n), ixw: new Float32Array(n), iyw: new Float32Array(n), jw: new Float32Array(n) };
  }
  const { iw, ixw, iyw, jw } = scratch;
  const top = Math.min(prev.length, next.length, opt.maxLevel + 1) - 1;
  const s0 = 1 / (1 << top);
  let gx = guessX * s0;
  let gy = guessY * s0;

  for (let l = top; l >= 0; l--) {
    const P = prev[l];
    const N = next[l];
    const scale = 1 / (1 << l);
    const cx = px * scale;
    const cy = py * scale;
    const w = P.width;
    const h = P.height;
    if (cx < 0 || cy < 0 || cx > w - 1 || cy > h - 1) return null;

    sampleWindow(P.data, w, h, cx, cy, r, iw);
    sampleWindow(P.gx, w, h, cx, cy, r, ixw);
    sampleWindow(P.gy, w, h, cx, cy, r, iyw);
    let a = 0;
    let b = 0;
    let c = 0;
    for (let k = 0; k < n; k++) {
      const ix = ixw[k];
      const iy = iyw[k];
      a += ix * ix;
      b += ix * iy;
      c += iy * iy;
    }
    const det = a * c - b * b;
    const minEig = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / (2 * n);
    if (minEig < opt.minEigen || Math.abs(det) < 1e-9) return null;
    const inv = 1 / det;

    let vx = 0;
    let vy = 0;
    for (let it = 0; it < opt.maxIterations; it++) {
      const ox = cx + gx + vx;
      const oy = cy + gy + vy;
      if (ox < -r || oy < -r || ox > w + r || oy > h + r) return null;
      sampleWindow(N.data, w, h, ox, oy, r, jw);
      let bx = 0;
      let by = 0;
      for (let k = 0; k < n; k++) {
        const diff = iw[k] - jw[k];
        bx += diff * ixw[k];
        by += diff * iyw[k];
      }
      const ex = inv * (c * bx - b * by);
      const ey = inv * (a * by - b * bx);
      vx += ex;
      vy += ey;
      if (ex * ex + ey * ey < opt.epsilon * opt.epsilon) break;
    }
    if (l > 0) {
      gx = 2 * (gx + vx);
      gy = 2 * (gy + vy);
    } else {
      gx += vx;
      gy += vy;
      if (opt.minNCC > -1) {
        sampleWindow(N.data, w, h, cx + gx, cy + gy, r, jw);
        if (ncc(iw, jw, n) < opt.minNCC) return null;
      }
    }
  }
  const nx = px + gx;
  const ny = py + gy;
  const w0 = next[0].width;
  const h0 = next[0].height;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || ny < 0 || nx > w0 - 1 || ny > h0 - 1) {
    return null;
  }
  return [nx, ny];
}

/**
 * Tracks points from `prev` to `next`. `points` is a flat [x0, y0, x1, y1, ...] array in level-0 pixels.
 * Returns the new positions (same layout) and a status array (1 = tracked).
 * `guess` optionally provides a predicted displacement per point (same layout).
 */
export function trackPoints(
  prev: Pyramid,
  next: Pyramid,
  points: Float32Array,
  options: Partial<LKOptions> = {},
  guess?: Float32Array,
): { points: Float32Array; status: Uint8Array } {
  const opt = { ...DEFAULT_LK, ...options };
  const count = points.length >> 1;
  const out = new Float32Array(points.length);
  const status = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const x = points[2 * i];
    const y = points[2 * i + 1];
    const fwd = trackOne(prev, next, x, y, opt, guess ? guess[2 * i] : 0, guess ? guess[2 * i + 1] : 0);
    if (!fwd) continue;
    if (Number.isFinite(opt.maxFBError)) {
      const back = trackOne(next, prev, fwd[0], fwd[1], opt, x - fwd[0], y - fwd[1]);
      if (!back) continue;
      const ex = back[0] - x;
      const ey = back[1] - y;
      if (ex * ex + ey * ey > opt.maxFBError * opt.maxFBError) continue;
    }
    out[2 * i] = fwd[0];
    out[2 * i + 1] = fwd[1];
    status[i] = 1;
  }
  return { points: out, status };
}
