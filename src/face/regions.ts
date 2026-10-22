/**
 * Measurement regions on the MediaPipe face mesh. The forehead and both cheeks carry the
 * strongest, steadiest pulse signal (flat, well-lit, little muscle motion); eyes, brows, lips and
 * hair are avoided. Each region is the convex hull of a set of landmarks.
 */
export const REGIONS = {
  // Between the brows and up the central forehead (glabella included).
  forehead: [9, 107, 66, 69, 108, 109, 10, 338, 337, 299, 296, 336, 151],
  // Below the eye, beside the nose (subject's right cheek, image left when not mirrored).
  rightCheek: [101, 118, 117, 123, 147, 187, 205, 36, 50],
  leftCheek: [330, 347, 346, 352, 376, 411, 425, 266, 280],
} as const;

export type RegionName = keyof typeof REGIONS;

/** Landmarks used to anchor overlays around the face. */
export const ANCHORS = {
  top: 10,
  chin: 152,
  rightTemple: 127,
  leftTemple: 356,
  rightCheek: 50,
  leftCheek: 280,
  noseTip: 1,
  rightEyeOuter: 33,
  leftEyeOuter: 263,
} as const;

export type Pt = [number, number];

export function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Region polygon (convex) in the same pixel space as `points` (flat x, y, z triples). */
export function regionPolygon(points: Float32Array, name: RegionName, scale = 1): Pt[] {
  return convexHull(REGIONS[name].map((i) => [points[3 * i] * scale, points[3 * i + 1] * scale] as Pt));
}

export function landmark(points: Float32Array, i: number): Pt {
  return [points[3 * i], points[3 * i + 1]];
}
