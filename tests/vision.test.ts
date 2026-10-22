import { describe, expect, it } from 'vitest';
import { applyH, fitHomography, invert3, mat3, multiply3, ransac, type Mat3 } from '../src/vision/homography';
import { buildPyramid } from '../src/vision/image';
import { trackPoints } from '../src/vision/lk';
import { detectCorners, snapToCorner } from '../src/vision/features';
import { PlanarTracker, similarTriangle } from '../src/vision/tracker';
import { makeTexture, rng, warp } from './synthetic';

const W = 270;
const H = 480;

/** Texture -> image homography for a camera looking at a poster, parameterized by time. */
function cameraPath(t: number): Mat3 {
  const tex = 400;
  const angle = 0.35 * Math.sin(t * 0.9);
  const scale = 0.55 + 0.12 * Math.sin(t * 0.6);
  const tx = W / 2 + 25 * Math.sin(t * 1.3);
  const ty = H / 2 + 30 * Math.cos(t * 0.8);
  const persp = 0.0004 * Math.sin(t * 0.7);
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  const center = mat3([1, 0, -tex / 2, 0, 1, -tex / 2, 0, 0, 1]);
  const sim = mat3([c, -s, tx, s, c, ty, 0, 0, 1]);
  const p = mat3([1, 0, 0, 0, 1, 0, persp, persp * 0.5, 1]);
  return multiply3(multiply3(sim, p), center);
}

describe('homography', () => {
  it('recovers an exact homography and rejects outliers', () => {
    const Htrue = mat3([1.2, 0.1, 30, -0.05, 0.9, 12, 0.0008, -0.0004, 1]);
    const r = rng(3);
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < 60; i++) {
      const x = r() * 300;
      const y = r() * 300;
      src.push(x, y);
      const [u, v] = applyH(Htrue, x, y);
      if (i % 4 === 0) dst.push(u + 40 * (r() - 0.5) + 15, v + 15);
      else dst.push(u + (r() - 0.5) * 0.4, v + (r() - 0.5) * 0.4);
    }
    const exact = fitHomography(src.slice(2), dst.slice(2), [0, 1, 2, 3]);
    expect(exact).not.toBeNull();
    const res = ransac(src, dst, { threshold: 2, random: rng(7) })!;
    expect(res.inlierCount).toBeGreaterThanOrEqual(44);
    for (const [x, y] of [[0, 0], [300, 0], [150, 220]]) {
      const [a, b] = applyH(res.H, x, y);
      const [c, d] = applyH(Htrue, x, y);
      expect(Math.hypot(a - c, b - d)).toBeLessThan(0.5);
    }
  });
});

describe('lucas-kanade', () => {
  it('tracks a sub-pixel translation', () => {
    const tex = makeTexture(400, 5);
    const A = warp(tex, mat3([1, 0, -60, 0, 1, -40, 0, 0, 1]), W, H);
    const B = warp(tex, mat3([1, 0, -60 + 6.3, 0, 1, -40 - 4.6, 0, 0, 1]), W, H);
    const pa = buildPyramid(A, 4);
    const pb = buildPyramid(B, 4);
    // Stay inside the poster: corners on its border with the background are not rigid.
    const pts = detectCorners(pa[0], { x0: 20, y0: 20, x1: W - 20, y1: 320 }, {
      maxCorners: 20,
      quality: 0.05,
      minResponse: 2,
      minDistance: 15,
    });
    expect(pts.length / 2).toBe(20);
    const res = trackPoints(pa, pb, Float32Array.from(pts));
    for (let i = 0; i < 20; i++) {
      expect(res.status[i]).toBe(1);
      expect(Math.abs(res.points[2 * i] - pts[2 * i] - 6.3)).toBeLessThan(0.15);
      expect(Math.abs(res.points[2 * i + 1] - pts[2 * i + 1] + 4.6)).toBeLessThan(0.15);
    }
  });
});

describe('planar tracker', () => {
  const tex = makeTexture(400, 11);

  function setup() {
    const G0 = cameraPath(0);
    const img0 = warp(tex, G0, W, H);
    const pyr0 = buildPyramid(img0, 4);
    const taps = [...applyH(G0, 120, 120), ...applyH(G0, 280, 120), ...applyH(G0, 120, 280)];
    const pins: number[] = [];
    for (let k = 0; k < 3; k++) {
      const s = snapToCorner(pyr0[0], taps[2 * k], taps[2 * k + 1], 12, 2);
      pins.push(s.x, s.y);
    }
    // Ground-truth pin positions in texture space.
    const G0inv = invert3(G0)!;
    const texPins = [0, 1, 2].map((k) => applyH(G0inv, pins[2 * k], pins[2 * k + 1]));
    const tracker = new PlanarTracker({ random: rng(1) });
    expect(tracker.init(pyr0, pins)).toBe(true);
    return { pyr0, pins, texPins, tracker };
  }

  it('follows the three pins through rotation, scale and perspective', () => {
    const { pyr0, texPins, tracker } = setup();
    expect(tracker.cur.length / 2).toBeGreaterThan(30);
    let prev = pyr0;
    let worst = 0;
    for (let f = 1; f <= 60; f++) {
      const G = cameraPath(f * 0.08);
      const pyr = buildPyramid(warp(tex, G, W, H), 4);
      const res = tracker.update(prev, pyr);
      expect(res.state).toBe('tracking');
      expect(res.H).not.toBeNull();
      const corners: [number, number][] = [[0, 0], [1, 0], [0, 1]];
      for (let k = 0; k < 3; k++) {
        const [x, y] = applyH(res.H!, ...corners[k]);
        const [gx, gy] = applyH(G, ...texPins[k]);
        worst = Math.max(worst, Math.hypot(x - gx, y - gy));
      }
      prev = pyr;
    }
    expect(worst).toBeLessThan(2);
  });

  it('declares the target lost when it disappears and relocalizes when it comes back', () => {
    const { pyr0, texPins, tracker } = setup();
    let prev = pyr0;
    // The camera pans away until the poster has left the frame.
    for (let f = 1; f <= 30; f++) {
      const pan = mat3([1, 0, -f * 18, 0, 1, f * 6, 0, 0, 1]);
      const pyr = buildPyramid(warp(tex, multiply3(pan, cameraPath(0)), W, H), 4);
      tracker.update(prev, pyr);
      prev = pyr;
    }
    expect(tracker.state).toBe('lost');
    // Bring the poster back at a slightly different pose.
    const G = cameraPath(0.15);
    let recovered = false;
    for (let f = 0; f < 6 && !recovered; f++) {
      const pyr = buildPyramid(warp(tex, G, W, H), 4);
      const res = tracker.update(prev, pyr);
      prev = pyr;
      if (res.state === 'tracking') {
        recovered = true;
        const [x, y] = applyH(tracker.H!, 0, 0);
        const [gx, gy] = applyH(G, ...texPins[0]);
        expect(Math.hypot(x - gx, y - gy)).toBeLessThan(3);
      }
    }
    expect(recovered).toBe(true);
  });

  it('compares triangle shapes for relocalization', () => {
    const a = [0, 0, 100, 0, 0, 100];
    expect(similarTriangle(a, [10, 10, 130, 10, 10, 130])).toBe(true);
    expect(similarTriangle(a, [0, 0, 0, 100, 100, 0])).toBe(false); // mirrored
    expect(similarTriangle(a, [0, 0, 300, 0, 0, 20])).toBe(false);
  });
});
