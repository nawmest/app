import {
  type V2,
  closestPoints,
  containsPoint,
  convexHull,
  dist2,
  polygonArea,
  closestInPolygon,
} from './geometry2d';

export type V3 = [number, number, number];

/** A horizontal surface (table top, floor, seat...) with a convex outline on the x/z plane. */
export interface Surface {
  id: number;
  /** Height of the surface (world y). */
  y: number;
  hull: V2[];
  hits: number;
  /** Enough evidence to walk on it. */
  confirmed: boolean;
  /** The companion has been on it. */
  discovered: boolean;
  /** Bumped whenever the outline or height changes. */
  version: number;
}

export interface SurfaceMapOptions {
  /** Max height difference for a hit to belong to a surface. */
  heightTolerance: number;
  /** Max horizontal distance from a surface's outline for a hit to extend it. */
  joinDistance: number;
  /** Min area and hits for a surface to be confirmed. */
  minArea: number;
  minHits: number;
  /** cos of the max tilt from horizontal for a hit to count. */
  minUpDot: number;
}

/**
 * Builds horizontal surfaces from hit points (WebXR hit-tests, simulated rays) and/or plane
 * polygons (WebXR plane detection). Hits at a similar height that are close to an existing
 * surface grow it; others start a new one. Overlapping surfaces at the same height merge.
 */
export class SurfaceMap {
  readonly surfaces: Surface[] = [];
  /** Incremented on every change; lets views rebuild lazily. */
  version = 0;
  private nextId = 1;
  private readonly redirects = new Map<number, number>();
  private readonly planeSurfaces = new Map<unknown, number>();
  readonly opt: SurfaceMapOptions;
  /**
   * Surfaces lower than this are at floor level (set from the camera height). Floor-level pieces
   * at the same height belong to one floor, however far apart they were first seen.
   */
  floorBelow = -Infinity;

  constructor(opt: Partial<SurfaceMapOptions> & Pick<SurfaceMapOptions, 'heightTolerance' | 'joinDistance' | 'minArea'>) {
    this.opt = { minHits: 4, minUpDot: Math.cos((15 * Math.PI) / 180), ...opt };
  }

  /** Surface id after merges. */
  resolve(id: number): number {
    let r = id;
    while (this.redirects.has(r)) r = this.redirects.get(r)!;
    return r;
  }

  get(id: number): Surface | undefined {
    const r = this.resolve(id);
    return this.surfaces.find((s) => s.id === r);
  }

  confirmedSurfaces(): Surface[] {
    return this.surfaces.filter((s) => s.confirmed);
  }

  /**
   * Adds a surface the AR system just confirmed at `p` (e.g. where the user tapped): a small
   * patch of the given radius, trusted immediately.
   */
  addPatch(p: V3, normal: V3, radius: number): Surface | null {
    let s = this.addHit(p, normal, this.opt.minHits);
    if (!s) return null;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      s = this.addHit([p[0] + Math.cos(a) * radius, p[1], p[2] + Math.sin(a) * radius], normal) ?? s;
    }
    const got = this.get(s.id)!;
    if (!got.confirmed && got.hull.length >= 3) {
      got.confirmed = true;
      got.version++;
      this.version++;
    }
    return got;
  }

  /** Adds a hit point with its surface normal. Returns the surface it went to, if any. */
  addHit(p: V3, normal: V3, weight = 1): Surface | null {
    const n = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    if (normal[1] / n < this.opt.minUpDot) return null;
    const q: V2 = [p[0], p[2]];
    let best: Surface | null = null;
    let bestD = Infinity;
    for (const s of this.surfaces) {
      if (Math.abs(s.y - p[1]) > this.opt.heightTolerance) continue;
      const d = s.hull.length >= 3 && containsPoint(s.hull, q) ? 0 : nearestDistance(s.hull, q);
      if (d < bestD && d <= this.opt.joinDistance) {
        bestD = d;
        best = s;
      }
    }
    if (!best) {
      best = { id: this.nextId++, y: p[1], hull: [q], hits: 0, confirmed: false, discovered: false, version: 0 };
      this.surfaces.push(best);
    }
    best.hits += weight;
    // Height: slow running average so a few noisy hits don't make it jump.
    best.y += ((p[1] - best.y) * Math.min(weight, 30)) / Math.min(best.hits, 30);
    if (bestD > 0 || best.hull.length < 3 || best.y < this.floorBelow) {
      best.hull = convexHull([...best.hull, q]);
      best.version++;
      this.version++;
      this.mergeAround(best);
    }
    this.updateConfirmed(best);
    return this.get(best.id) ?? null;
  }

  /** Adds or updates a detected plane polygon (world x/z points at height y). */
  addPolygon(key: unknown, y: number, polygon: V2[]): Surface | null {
    const hull = convexHull(polygon);
    if (hull.length < 3) return null;
    const id = this.planeSurfaces.get(key);
    let s = id !== undefined ? this.get(id) : undefined;
    if (!s) {
      // Attach to an existing surface at the same height that it overlaps.
      s = this.surfaces.find(
        (o) => Math.abs(o.y - y) <= this.opt.heightTolerance && o.hull.length >= 3 && closestPoints(o.hull, hull).d <= this.opt.joinDistance,
      );
      if (!s) {
        s = { id: this.nextId++, y, hull, hits: 0, confirmed: false, discovered: false, version: 0 };
        this.surfaces.push(s);
      }
      this.planeSurfaces.set(key, s.id);
    }
    s.y = y;
    s.hull = convexHull([...s.hull, ...hull]);
    s.hits = Math.max(s.hits, this.opt.minHits);
    s.version++;
    this.version++;
    this.mergeAround(s);
    const merged = this.get(s.id)!;
    this.updateConfirmed(merged);
    return merged;
  }

  /** Surface under a point (inside its outline, within `tolerance` in height). */
  surfaceAt(p: V3, tolerance = this.opt.heightTolerance * 2, confirmedOnly = true): Surface | null {
    let best: Surface | null = null;
    for (const s of this.surfaces) {
      if (confirmedOnly && !s.confirmed) continue;
      if (Math.abs(s.y - p[1]) > tolerance) continue;
      if (!containsPoint(s.hull, [p[0], p[2]])) continue;
      if (!best || Math.abs(s.y - p[1]) < Math.abs(best.y - p[1])) best = s;
    }
    return best;
  }

  /** The surface (and point on it) closest to p in 3D. */
  nearest(p: V3, confirmedOnly = true): { surface: Surface; point: V3; distance: number } | null {
    let best: { surface: Surface; point: V3; distance: number } | null = null;
    for (const s of this.surfaces) {
      if (confirmedOnly && !s.confirmed) continue;
      if (s.hull.length < 3) continue;
      const q = closestInPolygon(s.hull, [p[0], p[2]]);
      const pt: V3 = [q[0], s.y, q[1]];
      const d = Math.hypot(pt[0] - p[0], pt[1] - p[1], pt[2] - p[2]);
      if (!best || d < best.distance) best = { surface: s, point: pt, distance: d };
    }
    return best;
  }

  private updateConfirmed(s: Surface): void {
    if (s.confirmed) return;
    if (s.hits >= this.opt.minHits && s.hull.length >= 3 && polygonArea(s.hull) >= this.opt.minArea) {
      s.confirmed = true;
      s.version++;
      this.version++;
    }
  }

  private mergeAround(s: Surface): void {
    for (let i = this.surfaces.length - 1; i >= 0; i--) {
      const o = this.surfaces[i];
      if (o === s || Math.abs(o.y - s.y) > this.opt.heightTolerance) continue;
      const d = o.hull.length >= 3 && s.hull.length >= 3 ? closestPoints(o.hull, s.hull).d : nearestDistance(s.hull, o.hull[0]);
      const floor = s.y < this.floorBelow && o.y < this.floorBelow;
      if (d > this.opt.joinDistance * 0.5 && !floor) continue;
      // Merge o into s.
      const total = s.hits + o.hits;
      s.y = (s.y * s.hits + o.y * o.hits) / (total || 1);
      s.hits = total;
      s.hull = convexHull([...s.hull, ...o.hull]);
      s.discovered ||= o.discovered;
      s.confirmed ||= o.confirmed;
      s.version++;
      this.redirects.set(o.id, s.id);
      this.surfaces.splice(i, 1);
      this.version++;
    }
  }
}

function nearestDistance(hull: V2[], q: V2): number {
  if (hull.length >= 3) return dist2(closestInPolygon(hull, q), q);
  let d = Infinity;
  for (const p of hull) d = Math.min(d, dist2(p, q));
  if (hull.length === 2) {
    const [a, b] = hull;
    const ab: V2 = [b[0] - a[0], b[1] - a[1]];
    const l = ab[0] * ab[0] + ab[1] * ab[1];
    if (l > 0) {
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l));
      d = Math.min(d, dist2([a[0] + ab[0] * t, a[1] + ab[1] * t], q));
    }
  }
  return d;
}
