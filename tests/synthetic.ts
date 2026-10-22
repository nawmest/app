import { type GrayImage, createGray } from '../src/vision/image';
import { type Mat3, applyH, invert3 } from '../src/vision/homography';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A textured "poster": random rectangles and blobs over a gradient, sampled procedurally. */
export function makeTexture(size: number, seed = 1): GrayImage {
  const img = createGray(size, size);
  const r = rng(seed);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) img.data[y * size + x] = 90 + (60 * x) / size;
  for (let k = 0; k < 160; k++) {
    const w = 4 + r() * size * 0.12;
    const h = 4 + r() * size * 0.12;
    const x0 = r() * (size - w);
    const y0 = r() * (size - h);
    const v = r() * 255;
    for (let y = Math.floor(y0); y < y0 + h; y++)
      for (let x = Math.floor(x0); x < x0 + w; x++) img.data[y * size + x] = v;
  }
  return img;
}

/** Renders the texture through homography H (texture px -> image px) with bilinear sampling. */
export function warp(tex: GrayImage, H: Mat3, width: number, height: number, background = 40): GrayImage {
  const out = createGray(width, height);
  const Hi = invert3(H)!;
  const tw = tex.width;
  const th = tex.height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = applyH(Hi, x, y);
      let val = background + ((x * 7 + y * 13) % 5);
      if (u >= 0 && v >= 0 && u < tw - 1 && v < th - 1) {
        const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0;
        const i = y0 * tw + x0;
        const t = tex.data[i] + (tex.data[i + 1] - tex.data[i]) * ax;
        const b = tex.data[i + tw] + (tex.data[i + tw + 1] - tex.data[i + tw]) * ax;
        val = t + (b - t) * ay;
      }
      out.data[y * width + x] = val;
    }
  }
  return out;
}
