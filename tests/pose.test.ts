import { describe, expect, it } from 'vitest';
import { estimateIntrinsics, poseFromHomography, projectPoint } from '../src/ar/pose';
import { OneEuroFilter } from '../src/ar/filter';
import { mat3 } from '../src/vision/homography';

describe('poseFromHomography', () => {
  it('recovers a known pose of a square marker', () => {
    const K = estimateIntrinsics(270, 480);
    // Marker tilted 40 degrees about the x axis, 3 units in front of the camera.
    const a = (40 * Math.PI) / 180;
    const R = [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)]; // column-major
    const t = [-0.4, -0.3, 3];
    const pose0 = { R: Float64Array.from(R), t: Float64Array.from(t) };
    // H = K [r1 r2 t]
    const cols = [R.slice(0, 3), R.slice(3, 6), t];
    const H = mat3();
    for (let c = 0; c < 3; c++) {
      const [x, y, z] = cols[c];
      H[c] = K.f * x + K.cx * z;
      H[3 + c] = K.f * y + K.cy * z;
      H[6 + c] = z;
    }
    const pose = poseFromHomography(H, K)!;
    expect(pose).not.toBeNull();
    for (let i = 0; i < 9; i++) expect(pose.R[i]).toBeCloseTo(R[i], 6);
    for (let i = 0; i < 3; i++) expect(pose.t[i]).toBeCloseTo(t[i], 6);
    // A point above the plane projects identically.
    const [u1, v1] = projectPoint(pose, K, 0.5, 0.5, -0.7);
    const [u2, v2] = projectPoint(pose0, K, 0.5, 0.5, -0.7);
    expect(u1).toBeCloseTo(u2, 4);
    expect(v1).toBeCloseTo(v2, 4);
  });

  it('returns an orthonormal rotation for an affine (non-perspective) homography', () => {
    const K = estimateIntrinsics(480, 270);
    const H = mat3([90, 15, 200, -10, 70, 120, 0, 0, 1]);
    const pose = poseFromHomography(H, K)!;
    const R = pose.R;
    const dot = (i: number, j: number) => R[3 * i] * R[3 * j] + R[3 * i + 1] * R[3 * j + 1] + R[3 * i + 2] * R[3 * j + 2];
    expect(dot(0, 0)).toBeCloseTo(1, 9);
    expect(dot(1, 1)).toBeCloseTo(1, 9);
    expect(dot(0, 1)).toBeCloseTo(0, 9);
    expect(pose.t[2]).toBeGreaterThan(0);
    // The marker origin still lands on the pinned point.
    const [u, v] = projectPoint(pose, K, 0, 0, 0);
    expect(u).toBeCloseTo(200, 6);
    expect(v).toBeCloseTo(120, 6);
  });
});

describe('OneEuroFilter', () => {
  it('suppresses jitter but follows large moves', () => {
    const f = new OneEuroFilter(1, 1.0, 0.05);
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter([100 + (i % 2 ? 1 : -1)], i / 30)[0];
    expect(Math.abs(out - 100)).toBeLessThan(0.5);
    for (let i = 60; i < 75; i++) out = f.filter([100 + (i - 60) * 20], i / 30)[0];
    expect(out).toBeGreaterThan(300);
  });
});
