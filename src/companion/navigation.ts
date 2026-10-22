import {
  type V2,
  add2,
  clampInside,
  closestOnBoundary,
  closestPoints,
  containsPoint,
  dist2,
  outwardNormal,
  scale2,
  signedDistance,
} from './geometry2d';
import type { Surface, SurfaceMap, V3 } from './surfaces';

/** Movement abilities, in world units. Usually derived from the companion's height h. */
export interface NavParams {
  /** Companion height. */
  h: number;
  maxUp: number;
  maxDown: number;
  /** Max horizontal gap of a jump. */
  maxGap: number;
  /** Keep this far from surface edges when walking. */
  margin: number;
}

export function navParamsFor(h: number): NavParams {
  return { h, maxUp: 4 * h, maxDown: 8 * h, maxGap: 4 * h, margin: 0.35 * h };
}

export type Step =
  | { kind: 'walk'; surface: number; to: V3 }
  | { kind: 'jump'; from: V3; to: V3; fromSurface: number; toSurface: number };

export interface Plan {
  steps: Step[];
  /** False when the goal can't be reached and the plan only gets as close as possible. */
  reachesGoal: boolean;
  /** Total walking + jumping distance. */
  length: number;
  /** Final position. */
  end: V3;
  endSurface: number;
}

interface Transfer {
  takeoff: V2;
  landing: V2;
}

/**
 * How to get from surface A (standing at `from`) onto surface B, heading for `goal`.
 * Handles neighbouring surfaces (a gap to jump), a surface below (step off an edge) and a
 * surface above (jump up onto its edge from just outside it).
 */
export function transfer(A: Surface, B: Surface, from: V2, goal: V2, p: NavParams): Transfer | null {
  const dy = B.y - A.y;
  if (dy > p.maxUp || -dy > p.maxDown) return null;
  if (A.hull.length < 3 || B.hull.length < 3) return null;
  const { pa, pb, d } = closestPoints(A.hull, B.hull);
  const edgeIn = 0.15 * p.h;
  if (d > 1e-6) {
    if (d > p.maxGap) return null;
    return { takeoff: clampInside(A.hull, pa, edgeIn), landing: clampInside(B.hull, pb, p.margin) };
  }
  const out = 0.9 * p.h;
  if (Math.abs(dy) < 0.25 * p.h) {
    // Same level and touching: a small hop across the seam.
    const q = clampInside(B.hull, pa, p.margin);
    return { takeoff: clampInside(A.hull, pa, edgeIn), landing: q };
  }
  if (dy < 0) {
    // B is below A (e.g. table -> floor): step off the edge of A closest to the goal.
    const target = containsPoint(A.hull, goal) ? from : goal;
    const q = closestOnBoundary(A.hull, target);
    const n = outwardNormal(A.hull, q);
    let landing = add2(q, scale2(n, out));
    if (!containsPoint(B.hull, landing)) landing = clampInside(B.hull, landing, p.margin);
    if (signedDistance(A.hull, landing) < 0.2 * p.h) return null;
    return { takeoff: clampInside(A.hull, q, edgeIn), landing };
  }
  // B is above A (e.g. floor -> table): jump onto the edge of B nearest to where we are.
  const q = closestOnBoundary(B.hull, from);
  const n = outwardNormal(B.hull, q);
  let takeoff = add2(q, scale2(n, out));
  if (!containsPoint(A.hull, takeoff)) takeoff = clampInside(A.hull, takeoff, edgeIn);
  if (signedDistance(B.hull, takeoff) < 0.2 * p.h) return null;
  return { takeoff, landing: clampInside(B.hull, q, p.margin) };
}

const jumpCost = (t: Transfer, dy: number, p: NavParams) => dist2(t.takeoff, t.landing) + 1.5 * p.h + Math.abs(dy) * 0.5;

/**
 * Plans walks and jumps across surfaces from `start` to `goal` (Dijkstra over surfaces, where
 * entering a surface fixes the point the next leg starts from). If the goal is not on a reachable
 * surface, plans to the reachable point closest to it.
 */
export function planPath(
  map: SurfaceMap,
  start: { surface: number; pos: V3 },
  goal: V3,
  p: NavParams,
  goalSurfaceId?: number,
): Plan | null {
  const surfaces = map.confirmedSurfaces();
  const startS = map.get(start.surface);
  if (!startS) return null;
  const goalXZ: V2 = [goal[0], goal[2]];
  const goalS = goalSurfaceId !== undefined ? map.get(goalSurfaceId) : map.surfaceAt(goal, p.h * 0.5);

  interface Node {
    s: Surface;
    cost: number;
    entry: V2;
    prev: Node | null;
    via: Transfer | null;
    done: boolean;
  }
  const nodes = new Map<number, Node>();
  nodes.set(startS.id, { s: startS, cost: 0, entry: [start.pos[0], start.pos[2]], prev: null, via: null, done: false });
  for (;;) {
    let cur: Node | null = null;
    for (const n of nodes.values()) if (!n.done && (!cur || n.cost < cur.cost)) cur = n;
    if (!cur) break;
    cur.done = true;
    if (goalS && cur.s.id === goalS.id) break;
    for (const B of surfaces) {
      if (B.id === cur.s.id) continue;
      const t = transfer(cur.s, B, cur.entry, goalXZ, p);
      if (!t) continue;
      const cost = cur.cost + dist2(cur.entry, t.takeoff) + jumpCost(t, B.y - cur.s.y, p);
      const old = nodes.get(B.id);
      if (old && (old.done || old.cost <= cost)) continue;
      nodes.set(B.id, { s: B, cost, entry: t.landing, prev: cur, via: t, done: false });
    }
  }

  // Pick the destination: the goal surface if reached, otherwise the reached surface whose
  // closest point is nearest to the goal.
  let dest: Node | null = goalS ? (nodes.get(goalS.id) ?? null) : null;
  let destPoint: V2;
  let reaches = !!dest;
  if (dest) {
    destPoint = clampInside(dest.s.hull, goalXZ, p.margin);
  } else {
    let best = Infinity;
    destPoint = [start.pos[0], start.pos[2]];
    for (const n of nodes.values()) {
      if (!n.done) continue;
      const q = clampInside(n.s.hull, goalXZ, p.margin);
      const d = Math.hypot(q[0] - goal[0], n.s.y - goal[1], q[1] - goal[2]) + n.cost * 0.05;
      if (d < best) {
        best = d;
        dest = n;
        destPoint = q;
      }
    }
    reaches = false;
  }
  if (!dest) return null;

  // Rebuild the chain of surfaces.
  const chain: Node[] = [];
  for (let n: Node | null = dest; n; n = n.prev) chain.unshift(n);
  const steps: Step[] = [];
  let length = 0;
  let pos: V2 = [start.pos[0], start.pos[2]];
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1];
    const b = chain[i];
    const t = b.via!;
    if (dist2(pos, t.takeoff) > 1e-3) {
      steps.push({ kind: 'walk', surface: a.s.id, to: [t.takeoff[0], a.s.y, t.takeoff[1]] });
      length += dist2(pos, t.takeoff);
    }
    steps.push({
      kind: 'jump',
      from: [t.takeoff[0], a.s.y, t.takeoff[1]],
      to: [t.landing[0], b.s.y, t.landing[1]],
      fromSurface: a.s.id,
      toSurface: b.s.id,
    });
    length += dist2(t.takeoff, t.landing);
    pos = t.landing;
  }
  if (dist2(pos, destPoint) > 1e-3) {
    steps.push({ kind: 'walk', surface: dest.s.id, to: [destPoint[0], dest.s.y, destPoint[1]] });
    length += dist2(pos, destPoint);
  }
  return {
    steps,
    reachesGoal: reaches,
    length,
    end: [destPoint[0], dest.s.y, destPoint[1]],
    endSurface: dest.s.id,
  };
}
