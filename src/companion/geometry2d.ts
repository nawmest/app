/** 2D helpers on the horizontal (x, z) plane. Polygons are convex, counter-clockwise, flat [x, z] pairs. */

export type V2 = [number, number];

export const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const scale2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
export const len2 = (a: V2) => Math.hypot(a[0], a[1]);
export const dist2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm2 = (a: V2): V2 => {
  const l = len2(a) || 1;
  return [a[0] / l, a[1] / l];
};
const cross2 = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain. Returns a counter-clockwise hull (in x/z axes) without repeated points. */
export function convexHull(points: V2[]): V2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function centroid(poly: V2[]): V2 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / (poly.length || 1), z / (poly.length || 1)];
}

/** Signed distance from p to the convex polygon boundary: negative inside. */
export function signedDistance(poly: V2[], p: V2): number {
  if (poly.length < 3) return poly.length ? Math.min(...poly.map((q) => dist2(q, p))) : Infinity;
  const inside = containsPoint(poly, p);
  const d = dist2(closestOnBoundary(poly, p), p);
  return inside ? -d : d;
}

export function containsPoint(poly: V2[], p: V2): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross2(poly[i], poly[(i + 1) % poly.length], p);
    if (c === 0) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function closestOnSegment(a: V2, b: V2, p: V2): V2 {
  const ab = sub2(b, a);
  const l = dot2(ab, ab);
  const t = l > 0 ? Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / l)) : 0;
  return add2(a, scale2(ab, t));
}

export function closestOnBoundary(poly: V2[], p: V2): V2 {
  let best: V2 = poly[0];
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(poly[i], poly[(i + 1) % poly.length], p);
    const d = dist2(q, p);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** Closest point of the polygon (boundary or interior) to p. */
export function closestInPolygon(poly: V2[], p: V2): V2 {
  return containsPoint(poly, p) ? p : closestOnBoundary(poly, p);
}

/**
 * Moves p inside the polygon so that it is at least `margin` away from the boundary (or as far
 * in as the polygon allows, for small polygons).
 */
export function clampInside(poly: V2[], p: V2, margin: number): V2 {
  if (poly.length < 3) return poly.length ? centroid(poly) : p;
  const c = centroid(poly);
  const maxIn = -signedDistance(poly, c);
  const m = Math.min(margin, maxIn * 0.8);
  if (-signedDistance(poly, p) >= m) return p;
  // Binary search along the segment p -> centroid for the first point with enough clearance.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    const q = add2(p, scale2(sub2(c, p), t));
    if (-signedDistance(poly, q) >= m) hi = t;
    else lo = t;
  }
  return add2(p, scale2(sub2(c, p), hi));
}

/** Closest pair of points between two convex polygons (0 distance when they overlap). */
export function closestPoints(a: V2[], b: V2[]): { pa: V2; pb: V2; d: number } {
  let best = { pa: a[0], pb: b[0], d: Infinity };
  const test = (pa: V2, pb: V2) => {
    const d = dist2(pa, pb);
    if (d < best.d) best = { pa, pb, d };
  };
  for (const p of a) test(p, closestInPolygon(b, p));
  for (const p of b) test(closestInPolygon(a, p), p);
  return best;
}

/** Outward unit normal of the boundary nearest to p. */
export function outwardNormal(poly: V2[], p: V2): V2 {
  const q = closestOnBoundary(poly, p);
  const c = centroid(poly);
  const d = sub2(q, c);
  // Use the edge normal when p is (almost) on the boundary.
  let bestI = 0;
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const s = closestOnSegment(poly[i], poly[(i + 1) % poly.length], q);
    const dd = dist2(s, q);
    if (dd < bd) {
      bd = dd;
      bestI = i;
    }
  }
  const e = sub2(poly[(bestI + 1) % poly.length], poly[bestI]);
  let n: V2 = norm2([e[1], -e[0]]);
  if (dot2(n, d) < 0) n = scale2(n, -1);
  return n;
}

/** Uniformly random point inside a convex polygon (rejection sampling in the bounding box). */
export function randomPointIn(poly: V2[], rnd = Math.random): V2 {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]);
    z1 = Math.max(z1, p[1]);
  }
  for (let i = 0; i < 50; i++) {
    const p: V2 = [x0 + rnd() * (x1 - x0), z0 + rnd() * (z1 - z0)];
    if (containsPoint(poly, p)) return p;
  }
  return centroid(poly);
}
