import { describe, expect, it } from 'vitest';
import { type Vec3, cross, dot, eigSym3, mulMM, mulMV, normalize, transpose } from '../src/ar/linalg';
import { PlaneEstimator, decomposeHomography, squareSolutions } from '../src/ar/plane';
import { estimateIntrinsics, poseFromHomography, projectPoint } from '../src/ar/pose';
import { type Mat3, affineFromTriangle, applyH, invert3, mat3, multiply3 } from '../src/vision/homography';

const K = estimateIntrinsics(270, 480);
const deg = (r: number) => (r * 180) / Math.PI;
const angle = (a: Vec3, b: Vec3) => deg(Math.acos(Math.min(1, Math.abs(dot(normalize(a), normalize(b))))));

function rot(axis: Vec3, a: number): number[] {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/**
 * Camera looking at the world plane z = 0 from z < 0 (so the marker z axis points away from it).
 * `tilt` rotates the view about the camera x axis (0 = straight on), `orbit` swings the camera
 * sideways around the marker centre (in radians).
 */
function cameraPose(tilt: number, orbit: number, dist = 3): { R: number[]; t: Vec3 } {
  // Start fronto-parallel: world x -> cam x, world y -> cam y, world z -> cam z (away).
  const R = mulMM(rot([1, 0, 0], tilt), rot([0, 1, 0], orbit));
  const centre: Vec3 = [0.5, 0.5, 0];
  const rc = mulMV(R, centre);
  return { R, t: [-rc[0], -rc[1], dist - rc[2]] };
}

const project = (pose: { R: number[]; t: Vec3 }, X: Vec3): [number, number] => {
  const c = mulMV(pose.R, X);
  const z = c[2] + pose.t[2];
  return [K.cx + (K.f * (c[0] + pose.t[0])) / z, K.cy + (K.f * (c[1] + pose.t[1])) / z];
};

/** True plane (world z = 0) -> image homography. */
function planeH(pose: { R: number[]; t: Vec3 }): Mat3 {
  const { R, t } = pose;
  const M = [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]];
  return Float64Array.from(mulMM([K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1], M));
}

describe('eigSym3', () => {
  it('diagonalizes a symmetric matrix', () => {
    const m = [4, 1, 0.5, 1, 3, -0.2, 0.5, -0.2, 1];
    const { values, vectors } = eigSym3(m);
    expect(values[0]).toBeGreaterThanOrEqual(values[1]);
    expect(values[1]).toBeGreaterThanOrEqual(values[2]);
    vectors.forEach((v, i) => {
      const mv = mulMV(m, v);
      for (let k = 0; k < 3; k++) expect(mv[k]).toBeCloseTo(values[i] * v[k], 9);
    });
  });
});

describe('decomposeHomography', () => {
  it('recovers the plane normal among its two solutions', () => {
    const N: Vec3 = normalize([0.2, -0.5, 1]);
    const R = rot([0.3, 1, 0.1], 0.25);
    const T: Vec3 = [0.3, -0.1, 0.05];
    const H = R.map((v, i) => (v + T[Math.floor(i / 3)] * N[i % 3]) * 1.7);
    const sols = decomposeHomography(H, [0, 0, 1]);
    expect(sols.length).toBe(2);
    const best = sols.reduce((a, b) => (angle(a.N, N) < angle(b.N, N) ? a : b));
    expect(angle(best.N, N)).toBeLessThan(1e-4);
    for (let i = 0; i < 9; i++) expect(best.R[i]).toBeCloseTo(R[i], 6);
    for (let i = 0; i < 3; i++) expect(best.T[i]).toBeCloseTo(T[i], 6);
  });
});

describe('squareSolutions', () => {
  it('finds the true tilt of a square seen in perspective', () => {
    const pose = cameraPose(-0.9, 0.2); // looking down at a table at ~50 degrees
    const pins = [...project(pose, [0, 0, 0]), ...project(pose, [1, 0, 0]), ...project(pose, [0, 1, 0])];
    const trueN = normalize(mulMV(pose.R, [0, 0, 1]));
    const sols = squareSolutions(K, pins);
    expect(sols.length).toBeGreaterThan(0);
    expect(Math.min(...sols.map((s) => angle(s.normal, trueN)))).toBeLessThan(0.5);
  });
});

describe('PlaneEstimator', () => {
  /** Runs a camera path and returns the worst on-screen error of a point floating above the code. */
  function run(world: [Vec3, Vec3, Vec3], frames: { tilt: number; orbit: number }[]) {
    const pose0 = cameraPose(frames[0].tilt, frames[0].orbit);
    const pins = world.flatMap((p) => project(pose0, p));
    const A0 = affineFromTriangle(pins);
    const est = new PlaneEstimator(K, A0, pins);
    const G0inv = invert3(planeH(pose0))!;
    // Metric frame of the estimator: origin P1, x towards P2, y towards P3, unit = mean side.
    const e1 = normalize([world[1][0] - world[0][0], world[1][1] - world[0][1], 0]);
    const d3: Vec3 = [world[2][0] - world[0][0], world[2][1] - world[0][1], 0];
    const e2 = normalize([d3[0] - dot(d3, e1) * e1[0], d3[1] - dot(d3, e1) * e1[1], 0]);
    const side = 0.5 * (Math.hypot(world[1][0] - world[0][0], world[1][1] - world[0][1]) + Math.abs(dot(d3, e2)));
    const floating = (a: number, b: number, h: number): Vec3 => [
      world[0][0] + side * (a * e1[0] + b * e2[0]),
      world[0][1] + side * (a * e1[1] + b * e2[1]),
      -side * h, // towards the camera
    ];
    let lastErr = 0;
    const trueN = normalize(mulMV(pose0.R, [0, 0, 1]));
    for (const f of frames) {
      const pose = cameraPose(f.tilt, f.orbit);
      // Tracker output: marker (defined by the affine at lock) -> image.
      const Ht = multiply3(multiply3(planeH(pose), G0inv), A0);
      est.observe(Ht);
      for (let k = 0; k < 10; k++) est.step();
      const Hm = est.metricHomography(Ht)!;
      const p = poseFromHomography(Hm, K)!;
      const [u, v] = projectPoint(p, K, 0.5, 0.5, -0.5);
      const [tu, tv] = project(pose, floating(0.5, 0.5, 0.5));
      lastErr = Math.hypot(u - tu, v - tv);
    }
    return { est, lastErr, normalErr: angle(est.normal, trueN) };
  }

  const path = Array.from({ length: 40 }, (_, i) => ({ tilt: -0.8 + 0.15 * Math.sin(i / 6), orbit: 0.45 * Math.sin(i / 8) }));

  it('places 3D content correctly right away when the taps form a square', () => {
    const r = run([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [path[0]]);
    expect(r.est.source).toBe('square');
    expect(r.normalErr).toBeLessThan(1);
    expect(r.lastErr).toBeLessThan(0.5);
  });

  it('learns the true plane from camera motion when the taps are not a square', () => {
    const first = run([[0, 0, 0], [1, 0, 0], [0, 0.55, 0]], [path[0]]);
    expect(first.normalErr).toBeGreaterThan(5); // the square assumption is wrong here
    const r = run([[0, 0, 0], [1, 0, 0], [0, 0.55, 0]], path);
    expect(r.est.confidence).toBeGreaterThan(1);
    expect(r.normalErr).toBeLessThan(2);
    expect(r.lastErr).toBeLessThan(3);
  });

  it('keeps a fronto-parallel pose exact', () => {
    const r = run([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [{ tilt: 0, orbit: 0 }]);
    expect(r.normalErr).toBeLessThan(1);
    expect(r.lastErr).toBeLessThan(0.5);
  });
});

// Silence unused helper warnings in strict mode.
void cross;
void transpose;
void mat3;
void applyH;
