import { describe, expect, it } from 'vitest';
import { clampInside, closestPoints, containsPoint, convexHull, signedDistance, type V2 } from '../src/companion/geometry2d';
import { SurfaceMap, type V3 } from '../src/companion/surfaces';
import { navParamsFor, planPath } from '../src/companion/navigation';
import { CompanionBrain } from '../src/companion/brain';
import { rng } from './synthetic';

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** A room in metres: floor, table, stool next to the table, a high shelf. */
function room() {
  const map = new SurfaceMap({ heightTolerance: 0.04, joinDistance: 0.3, minArea: 0.01 });
  const floor = map.addPolygon('floor', 0, rect(-2, -2, 2, 2))!;
  const table = map.addPolygon('table', 0.75, rect(-0.6, -0.35, 0.6, 0.35))!;
  const stool = map.addPolygon('stool', 0.45, rect(0.75, -0.2, 1.1, 0.15))!;
  const shelf = map.addPolygon('shelf', 1.9, rect(-1.9, 1.5, -1.2, 1.8))!;
  return { map, floor, table, stool, shelf };
}

describe('geometry2d', () => {
  it('builds hulls and tests containment', () => {
    const hull = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.2, 0.9]]);
    expect(hull.length).toBe(4);
    expect(containsPoint(hull, [0.5, 0.5])).toBe(true);
    expect(containsPoint(hull, [1.5, 0.5])).toBe(false);
    expect(signedDistance(hull, [0.5, 0.1])).toBeCloseTo(-0.1);
  });
  it('clamps points away from edges', () => {
    const p = clampInside(rect(0, 0, 1, 1), [1.2, 0.5], 0.1);
    expect(signedDistance(rect(0, 0, 1, 1), p)).toBeLessThanOrEqual(-0.099);
  });
  it('finds closest points between polygons', () => {
    const r = closestPoints(rect(0, 0, 1, 1), rect(1.5, 0, 2, 1));
    expect(r.d).toBeCloseTo(0.5);
    expect(closestPoints(rect(0, 0, 1, 1), rect(0.5, 0.5, 2, 2)).d).toBe(0);
  });
});

describe('SurfaceMap', () => {
  it('groups hits by height and merges pieces of the same surface', () => {
    const map = new SurfaceMap({ heightTolerance: 0.04, joinDistance: 0.3, minArea: 0.02 });
    const r = rng(2);
    for (let i = 0; i < 200; i++) map.addHit([r() * 2 - 1, 0.005 * (r() - 0.5), r() * 2 - 1], [0, 1, 0]);
    for (let i = 0; i < 60; i++) map.addHit([0.3 + r() * 0.5, 0.75, 0.2 + r() * 0.4], [0, 1, 0]);
    map.addHit([0, 0.4, 0], [1, 0, 0]); // a wall hit is ignored
    const s = map.confirmedSurfaces();
    expect(s.length).toBe(2);
    expect(Math.min(...s.map((x) => x.y))).toBeCloseTo(0, 2);
    expect(Math.max(...s.map((x) => x.y))).toBeCloseTo(0.75, 2);
  });
});

describe('planPath', () => {
  const h = 0.2;
  const nav = navParamsFor(h);
  it('jumps down from the table to reach the floor', () => {
    const { map, table } = room();
    const plan = planPath(map, { surface: table.id, pos: [0, 0.75, 0] }, [1.5, 0, 1.5], nav)!;
    expect(plan.reachesGoal).toBe(true);
    expect(plan.steps.filter((s) => s.kind === 'jump').length).toBe(1);
    expect(plan.end[1]).toBe(0);
  });
  it('climbs from the floor onto the table via the stool when the table is too high', () => {
    const { map, floor, table } = room();
    const low = { ...nav, maxUp: 0.5 }; // can't reach 0.75 from the floor directly
    const plan = planPath(map, { surface: floor.id, pos: [1.6, 0, 0] }, [-0.3, 0.75, 0], low)!;
    expect(plan.reachesGoal).toBe(true);
    const jumps = plan.steps.filter((s) => s.kind === 'jump');
    expect(jumps.length).toBe(2); // floor -> stool -> table
    expect(plan.endSurface).toBe(table.id);
  });
  it('gets as close as possible to an unreachable shelf', () => {
    const { map, table, floor } = room();
    const plan = planPath(map, { surface: table.id, pos: [0, 0.75, 0] }, [-1.5, 1.9, 1.6], nav)!;
    expect(plan.reachesGoal).toBe(false);
    expect(plan.endSurface).toBe(floor.id);
  });
});

describe('CompanionBrain', () => {
  const h = 0.2;
  const make = (map: SurfaceMap, surface: number, pos: V3, events = {}) =>
    new CompanionBrain(map, { pos, surface }, { height: h, nav: navParamsFor(h), gravity: 9.81, walkSpeed: 0.15, runSpeed: 0.25, random: rng(5), events });

  it('walks and jumps to a tapped point on another surface, then waves', () => {
    const { map, table, stool } = room();
    table.discovered = true;
    let arrived: boolean | null = null;
    let minY = Infinity;
    let maxY = -Infinity;
    const b = make(map, table.id, [-0.3, 0.75, 0], { arrived: (r: boolean) => (arrived = r) });
    const target: V3 = [0.95, 0.45, 0];
    b.goTo(target);
    for (let i = 0; i < 60 * 30 && arrived === null; i++) {
      b.update(1 / 60, [0, 1.5, 1.5]);
      minY = Math.min(minY, b.pos[1]);
      maxY = Math.max(maxY, b.pos[1]);
    }
    expect(arrived).toBe(true);
    expect(b.surface).toBe(stool.id);
    expect(Math.hypot(b.pos[0] - target[0], b.pos[2] - target[2])).toBeLessThan(0.15);
    expect(maxY).toBeGreaterThan(0.75); // a real arc, not a slide
    expect(minY).toBeGreaterThan(0.44);
    b.update(1 / 60, [0, 1.5, 1.5]);
    expect(b.anim).toBe('Wave');
  });

  it('explores reachable undiscovered surfaces on its own', () => {
    const { map, table, stool } = room();
    table.discovered = true;
    const found: number[] = [];
    const b = make(map, table.id, [0, 0.75, 0], { discovered: (s: { id: number }) => found.push(s.id) });
    for (let i = 0; i < 60 * 120; i++) b.update(1 / 60, [0, 1.5, 1.5]);
    expect(found).toContain(stool.id);
    expect(found.length).toBeGreaterThanOrEqual(2); // stool and floor
  });
});
