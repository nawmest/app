import { type Pt, REGIONS, type RegionName, regionPolygon } from '../face/regions';

export interface SkinSample {
  /** Mean colour of all measurement regions, weighted by their skin pixel counts. */
  rgb: [number, number, number];
  pixels: number;
  /** Mean luminance (0-255) and fraction of clipped (over-exposed) pixels, for light checks. */
  luminance: number;
  clipped: number;
}

/**
 * Averages the skin colour inside the forehead and cheek regions of each frame. The frame is
 * downscaled first (averaging is what matters, not detail), and each convex region is rasterised
 * row by row. Very dark pixels (brows, shadows) and clipped highlights are skipped.
 */
export class SkinSampler {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scale: number;
  readonly width: number;
  readonly height: number;

  constructor(videoWidth: number, videoHeight: number, maxSide = 360) {
    this.scale = Math.min(1, maxSide / Math.max(videoWidth, videoHeight));
    this.width = Math.round(videoWidth * this.scale);
    this.height = Math.round(videoHeight * this.scale);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  sample(video: CanvasImageSource, points: Float32Array): SkinSample | null {
    const polys = (Object.keys(REGIONS) as RegionName[]).map((r) => regionPolygon(points, r, this.scale));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys.flat()) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.width - 1, Math.ceil(x1));
    y1 = Math.min(this.height - 1, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return null;
    // Copy only the face's bounding box from the video (cheaper than the whole frame).
    const s = 1 / this.scale;
    this.ctx.drawImage(video, x0 * s, y0 * s, (x1 - x0 + 1) * s, (y1 - y0 + 1) * s, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    const w = x1 - x0 + 1;
    const img = this.ctx.getImageData(x0, y0, w, y1 - y0 + 1).data;
    let r = 0, g = 0, b = 0, n = 0, lum = 0, clipped = 0, total = 0;
    for (const poly of polys) {
      forEachSpan(poly, (y, xa, xb) => {
        if (y < y0 || y > y1) return;
        const row = (y - y0) * w;
        for (let x = Math.max(x0, xa); x <= Math.min(x1, xb); x++) {
          const i = (row + x - x0) * 4;
          const R = img[i], G = img[i + 1], B = img[i + 2];
          const L = 0.299 * R + 0.587 * G + 0.114 * B;
          total++;
          if (R >= 250 || G >= 250 || B >= 250) {
            clipped++;
            continue;
          }
          if (L < 25) continue;
          r += R;
          g += G;
          b += B;
          lum += L;
          n++;
        }
      });
    }
    if (n < 30) return null;
    return { rgb: [r / n, g / n, b / n], pixels: n, luminance: lum / n, clipped: clipped / Math.max(1, total) };
  }
}

/** Calls `fn(y, xStart, xEnd)` for every pixel row covered by a convex polygon. */
export function forEachSpan(poly: Pt[], fn: (y: number, xa: number, xb: number) => void): void {
  if (poly.length < 3) return;
  let ymin = Infinity, ymax = -Infinity;
  for (const p of poly) {
    ymin = Math.min(ymin, p[1]);
    ymax = Math.max(ymax, p[1]);
  }
  for (let y = Math.ceil(ymin); y <= Math.floor(ymax); y++) {
    let xa = Infinity, xb = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      if ((ay <= y && by >= y) || (by <= y && ay >= y)) {
        const x = ay === by ? Math.min(ax, bx) : ax + ((y - ay) / (by - ay)) * (bx - ax);
        const x2 = ay === by ? Math.max(ax, bx) : x;
        xa = Math.min(xa, x);
        xb = Math.max(xb, x2);
      }
    }
    if (xa <= xb) fn(y, Math.ceil(xa), Math.floor(xb));
  }
}
