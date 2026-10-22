import type { PyramidLevel } from './image';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Shi-Tomasi corner response (min eigenvalue of the 5x5 structure tensor, normalized per pixel)
 * computed inside `roi`. Returns a response map covering the roi.
 */
export function cornerResponse(level: PyramidLevel, roi: Rect): { map: Float32Array; rect: Rect; width: number } {
  const { width: w, height: h, gx, gy } = level;
  const r = 2;
  const x0 = Math.max(r + 1, Math.floor(roi.x0));
  const y0 = Math.max(r + 1, Math.floor(roi.y0));
  const x1 = Math.min(w - r - 2, Math.ceil(roi.x1));
  const y1 = Math.min(h - r - 2, Math.ceil(roi.y1));
  const rw = Math.max(0, x1 - x0 + 1);
  const rh = Math.max(0, y1 - y0 + 1);
  const map = new Float32Array(rw * rh);
  const norm = 1 / ((2 * r + 1) * (2 * r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let dy = -r; dy <= r; dy++) {
        let i = (y + dy) * w + x - r;
        for (let dx = -r; dx <= r; dx++, i++) {
          const ix = gx[i];
          const iy = gy[i];
          a += ix * ix;
          b += ix * iy;
          c += iy * iy;
        }
      }
      map[(y - y0) * rw + (x - x0)] = ((a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2) * norm;
    }
  }
  return { map, rect: { x0, y0, x1, y1 }, width: rw };
}

export interface DetectOptions {
  maxCorners: number;
  /** Relative threshold w.r.t. the strongest response. */
  quality: number;
  /** Absolute minimum response. */
  minResponse: number;
  minDistance: number;
  /** Optional mask; return false to reject a candidate. */
  accept?: (x: number, y: number) => boolean;
  /** Existing points (flat xy) that new corners must keep `minDistance` away from. */
  existing?: ArrayLike<number>;
}

/** Good-features-to-track style detector. Returns flat [x, y, ...] positions. */
export function detectCorners(level: PyramidLevel, roi: Rect, opt: DetectOptions): number[] {
  const { map, rect, width: rw } = cornerResponse(level, roi);
  const rh = rect.y1 - rect.y0 + 1;
  if (rw <= 2 || rh <= 2) return [];
  let max = 0;
  for (let i = 0; i < map.length; i++) if (map[i] > max) max = map[i];
  const thr = Math.max(opt.minResponse, max * opt.quality);
  const cand: { x: number; y: number; v: number }[] = [];
  for (let y = 1; y < rh - 1; y++) {
    for (let x = 1; x < rw - 1; x++) {
      const i = y * rw + x;
      const v = map[i];
      if (v < thr) continue;
      // 3x3 non-maximum suppression
      if (
        v < map[i - 1] || v < map[i + 1] || v < map[i - rw] || v < map[i + rw] ||
        v < map[i - rw - 1] || v < map[i - rw + 1] || v < map[i + rw - 1] || v < map[i + rw + 1]
      ) continue;
      const px = x + rect.x0;
      const py = y + rect.y0;
      if (opt.accept && !opt.accept(px, py)) continue;
      cand.push({ x: px, y: py, v });
    }
  }
  cand.sort((p, q) => q.v - p.v);

  // Occupancy grid for the min-distance test.
  const cell = Math.max(1, opt.minDistance);
  const gw = Math.ceil(level.width / cell) + 1;
  const gh = Math.ceil(level.height / cell) + 1;
  const grid: number[][] = new Array(gw * gh);
  const d2 = opt.minDistance * opt.minDistance;
  const out: number[] = [];
  const occupied = (x: number, y: number): boolean => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let j = cy - 1; j <= cy + 1; j++) {
      if (j < 0 || j >= gh) continue;
      for (let i = cx - 1; i <= cx + 1; i++) {
        if (i < 0 || i >= gw) continue;
        const bucket = grid[j * gw + i];
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k += 2) {
          const ex = bucket[k] - x;
          const ey = bucket[k + 1] - y;
          if (ex * ex + ey * ey < d2) return true;
        }
      }
    }
    return false;
  };
  const occupy = (x: number, y: number) => {
    const idx = Math.floor(y / cell) * gw + Math.floor(x / cell);
    (grid[idx] ??= []).push(x, y);
  };
  if (opt.existing) {
    for (let k = 0; k + 1 < opt.existing.length; k += 2) {
      const x = opt.existing[k];
      const y = opt.existing[k + 1];
      if (x >= 0 && y >= 0 && x < level.width && y < level.height) occupy(x, y);
    }
  }
  for (const c of cand) {
    if (out.length / 2 >= opt.maxCorners) break;
    if (occupied(c.x, c.y)) continue;
    occupy(c.x, c.y);
    out.push(c.x, c.y);
  }
  return out;
}

export interface SnapResult {
  x: number;
  y: number;
  response: number;
  snapped: boolean;
}

/**
 * Moves a tapped location to the strongest nearby corner so it can be tracked reliably.
 * Candidates farther from the tap are slightly penalized.
 */
export function snapToCorner(level: PyramidLevel, x: number, y: number, radius: number, minResponse: number): SnapResult {
  const { map, rect, width: rw } = cornerResponse(level, {
    x0: x - radius,
    y0: y - radius,
    x1: x + radius,
    y1: y + radius,
  });
  let best = -1;
  let bx = x;
  let by = y;
  let bestRaw = 0;
  const rh = rect.y1 - rect.y0 + 1;
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      const px = i + rect.x0;
      const py = j + rect.y0;
      const d2 = (px - x) * (px - x) + (py - y) * (py - y);
      if (d2 > radius * radius) continue;
      const v = map[j * rw + i];
      const score = v * (1 - 0.5 * (d2 / (radius * radius)));
      if (score > best) {
        best = score;
        bestRaw = v;
        bx = px;
        by = py;
      }
    }
  }
  if (bestRaw < minResponse) return { x, y, response: bestRaw, snapped: false };
  return { x: bx, y: by, response: bestRaw, snapped: true };
}
