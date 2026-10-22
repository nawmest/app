import { describe, expect, it } from 'vitest';
import { qrFrameFromPoints } from '../src/ar/qrFrame';

const apply = (m: number[], v: [number, number, number]) => [0, 1, 2].map((i) => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i]);

describe('qrFrameFromPoints', () => {
  it('maps content space onto the tapped square on a table', () => {
    // Table at y = 0; looking down -z, so the bottom-left corner is nearer (+z).
    const f = qrFrameFromPoints([0, 0, 0], [0.2, 0, 0], [0, 0, 0.2], [0, 1, 0])!;
    expect(f.side).toBeCloseTo(0.2);
    expect(f.swapped).toBe(false);
    const p1 = apply(f.matrix, [-0.5, 0, -0.5]);
    const p2 = apply(f.matrix, [0.5, 0, -0.5]);
    const p3 = apply(f.matrix, [-0.5, 0, 0.5]);
    const top = apply(f.matrix, [0, 1, 0]);
    [[p1, [0, 0, 0]], [p2, [0.2, 0, 0]], [p3, [0, 0, 0.2]], [top, [0.1, 0.2, 0.1]]].forEach(([a, b]) =>
      a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9)),
    );
  });

  it('swaps pins placed the other way round instead of putting content under the surface', () => {
    const f = qrFrameFromPoints([0, 0, 0], [0, 0, 0.2], [0.2, 0, 0], [0, 1, 0])!;
    expect(f.swapped).toBe(true);
    expect(apply(f.matrix, [0, 1, 0])[1]).toBeCloseTo(0.2);
  });

  it('works on a wall', () => {
    // Wall facing +z; up out of the wall is +z; top-left, top-right, bottom-left.
    const f = qrFrameFromPoints([0, 1, 0], [0.3, 1, 0], [0, 0.7, 0], [0, 0, 1])!;
    expect(f.swapped).toBe(false);
    const out = apply(f.matrix, [0, 1, 0]);
    expect(out[2]).toBeCloseTo(0.3);
  });
});
