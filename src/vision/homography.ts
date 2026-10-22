/** 3x3 matrices are row-major arrays of 9 numbers. */
export type Mat3 = Float64Array;

export function mat3(values?: ArrayLike<number>): Mat3 {
  const m = new Float64Array(9);
  if (values) m.set(values);
  else m[0] = m[4] = m[8] = 1;
  return m;
}

export function multiply3(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return mat3([
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ]);
}

export function applyH(H: Mat3, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Gaussian elimination with partial pivoting. Solves A x = b in place; returns null if singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r][col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) return null;
    if (piv !== col) {
      [A[piv], A[col]] = [A[col], A[piv]];
      [b[piv], b[col]] = [b[col], b[piv]];
    }
    const inv = 1 / A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] * inv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Hartley normalization: translate to centroid, scale so mean distance is sqrt(2). */
function normalization(pts: ArrayLike<number>, idx: ArrayLike<number>): Mat3 {
  let cx = 0;
  let cy = 0;
  const n = idx.length;
  for (let k = 0; k < n; k++) {
    cx += pts[2 * idx[k]];
    cy += pts[2 * idx[k] + 1];
  }
  cx /= n;
  cy /= n;
  let d = 0;
  for (let k = 0; k < n; k++) {
    d += Math.hypot(pts[2 * idx[k]] - cx, pts[2 * idx[k] + 1] - cy);
  }
  d /= n;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return mat3([s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]);
}

function allIndices(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Least-squares homography mapping src -> dst (flat xy arrays) using the points in `idx`
 * (at least 4). Normalized DLT with h33 = 1.
 */
export function fitHomography(src: ArrayLike<number>, dst: ArrayLike<number>, idx?: ArrayLike<number>): Mat3 | null {
  const ids = idx ?? allIndices(src.length >> 1);
  if (ids.length < 4) return null;
  const Ts = normalization(src, ids);
  const Td = normalization(dst, ids);
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const row = new Array<number>(8);
  const accumulate = (r: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (r[i] === 0) continue;
      Atb[i] += r[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j];
    }
  };
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k];
    const x = Ts[0] * src[2 * i] + Ts[2];
    const y = Ts[4] * src[2 * i + 1] + Ts[5];
    const u = Td[0] * dst[2 * i] + Td[2];
    const v = Td[4] * dst[2 * i + 1] + Td[5];
    row[0] = x; row[1] = y; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -u * x; row[7] = -u * y;
    accumulate(row, u);
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = x; row[4] = y; row[5] = 1; row[6] = -v * x; row[7] = -v * y;
    accumulate(row, v);
  }
  const h = solve(AtA, Atb);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  const Hn = mat3([...h, 1]);
  const TdInv = invert3(Td);
  if (!TdInv) return null;
  const H = multiply3(multiply3(TdInv, Hn), Ts);
  if (Math.abs(H[8]) < 1e-12) return null;
  const s = 1 / H[8];
  for (let i = 0; i < 9; i++) H[i] *= s;
  return H;
}

/** Least-squares affine transform src -> dst (as a 3x3 matrix) from at least 3 points. */
export function fitAffine(src: ArrayLike<number>, dst: ArrayLike<number>, idx?: ArrayLike<number>): Mat3 | null {
  const ids = idx ?? allIndices(src.length >> 1);
  if (ids.length < 3) return null;
  // Solve two independent 3-parameter problems sharing the normal matrix.
  const N: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k];
    const r = [src[2 * i], src[2 * i + 1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) N[a][b] += r[a] * r[b];
      bu[a] += r[a] * dst[2 * i];
      bv[a] += r[a] * dst[2 * i + 1];
    }
  }
  const p = solve(N.map((r) => r.slice()), bu);
  const q = solve(N, bv);
  if (!p || !q) return null;
  return mat3([p[0], p[1], p[2], q[0], q[1], q[2], 0, 0, 1]);
}

export interface RansacResult {
  H: Mat3;
  inliers: Uint8Array;
  inlierCount: number;
}

export interface RansacOptions {
  /** Inlier threshold in dst units (pixels). */
  threshold: number;
  maxIterations?: number;
  confidence?: number;
  model?: 'homography' | 'affine';
  /** Deterministic RNG for tests. */
  random?: () => number;
}

function reprojErr2(H: Mat3, src: ArrayLike<number>, dst: ArrayLike<number>, i: number): number {
  const x = src[2 * i];
  const y = src[2 * i + 1];
  const w = H[6] * x + H[7] * y + H[8];
  if (w <= 1e-9) return Infinity;
  const u = (H[0] * x + H[1] * y + H[2]) / w - dst[2 * i];
  const v = (H[3] * x + H[4] * y + H[5]) / w - dst[2 * i + 1];
  return u * u + v * v;
}

function score(H: Mat3, src: ArrayLike<number>, dst: ArrayLike<number>, n: number, t2: number, mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < n; i++) {
    const ok = reprojErr2(H, src, dst, i) < t2;
    mask[i] = ok ? 1 : 0;
    if (ok) c++;
  }
  return c;
}

function collinear(pts: ArrayLike<number>, a: number, b: number, c: number): boolean {
  const ax = pts[2 * a], ay = pts[2 * a + 1];
  const bx = pts[2 * b] - ax, by = pts[2 * b + 1] - ay;
  const cx = pts[2 * c] - ax, cy = pts[2 * c + 1] - ay;
  const cross = Math.abs(bx * cy - by * cx);
  const scale = Math.max(bx * bx + by * by, cx * cx + cy * cy);
  return cross < 1e-3 * scale + 1e-12;
}

/** Robust model fit with RANSAC followed by least-squares refinement on the inliers. */
export function ransac(src: ArrayLike<number>, dst: ArrayLike<number>, opt: RansacOptions): RansacResult | null {
  const n = src.length >> 1;
  const model = opt.model ?? 'homography';
  const m = model === 'homography' ? 4 : 3;
  if (n < m) return null;
  const fit = model === 'homography' ? fitHomography : fitAffine;
  const rnd = opt.random ?? Math.random;
  const t2 = opt.threshold * opt.threshold;
  const conf = opt.confidence ?? 0.995;
  let maxIt = opt.maxIterations ?? 200;
  let best: Mat3 | null = null;
  let bestCount = -1;
  const mask = new Uint8Array(n);
  const sample = new Array<number>(m);

  for (let it = 0; it < maxIt; it++) {
    // Draw m distinct indices.
    for (let k = 0; k < m; k++) {
      let r: number;
      do {
        r = Math.floor(rnd() * n);
      } while (sample.slice(0, k).includes(r));
      sample[k] = r;
    }
    let degenerate = false;
    for (let a = 0; a < m && !degenerate; a++)
      for (let b = a + 1; b < m && !degenerate; b++)
        for (let c = b + 1; c < m && !degenerate; c++)
          if (collinear(src, sample[a], sample[b], sample[c]) || collinear(dst, sample[a], sample[b], sample[c]))
            degenerate = true;
    if (degenerate) continue;
    const H = fit(src, dst, sample);
    if (!H) continue;
    const count = score(H, src, dst, n, t2, mask);
    if (count > bestCount) {
      bestCount = count;
      best = H;
      const ratio = count / n;
      const denom = Math.log(1 - Math.pow(ratio, m));
      if (denom < 0) maxIt = Math.min(maxIt, Math.ceil(Math.log(1 - conf) / denom));
    }
  }
  if (!best || bestCount < m) return null;

  // Refine twice on the inlier set.
  let H = best;
  for (let pass = 0; pass < 2; pass++) {
    score(H, src, dst, n, t2, mask);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) ids.push(i);
    if (ids.length < m) break;
    const refined = fit(src, dst, ids);
    if (!refined) break;
    H = refined;
  }
  const inlierCount = score(H, src, dst, n, t2, mask);
  if (inlierCount < m) return null;
  return { H, inliers: mask, inlierCount };
}

/** Exact homography from four point correspondences. */
export function homographyFrom4(src: ArrayLike<number>, dst: ArrayLike<number>): Mat3 | null {
  return fitHomography(src, dst, [0, 1, 2, 3]);
}

/** Affine transform mapping the unit triangle (0,0),(1,0),(0,1) to p0, p1, p2. */
export function affineFromTriangle(p: ArrayLike<number>): Mat3 {
  return mat3([p[2] - p[0], p[4] - p[0], p[0], p[3] - p[1], p[5] - p[1], p[1], 0, 0, 1]);
}

/** True if the quad (flat xy, in order) is strictly convex and consistently wound. */
export function isConvexQuad(q: ArrayLike<number>): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[2 * i], ay = q[2 * i + 1];
    const bx = q[2 * ((i + 1) % 4)], by = q[2 * ((i + 1) % 4) + 1];
    const cx = q[2 * ((i + 2) % 4)], cy = q[2 * ((i + 2) % 4) + 1];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function polygonArea(q: ArrayLike<number>): number {
  const n = q.length >> 1;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += q[2 * i] * q[2 * j + 1] - q[2 * j] * q[2 * i + 1];
  }
  return a / 2;
}

/** Projects the marker's unit-square corners (0,0),(1,0),(1,1),(0,1) through H. */
export function markerQuad(H: Mat3): number[] {
  const out: number[] = [];
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) out.push(...applyH(H, u, v));
  return out;
}
