/**
 * Grayscale images and Gaussian pyramids used by the tracker.
 * All pixel values are floats in [0, 255].
 */

export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export interface PyramidLevel extends GrayImage {
  /** Horizontal gradient (central difference). */
  gx: Float32Array;
  /** Vertical gradient (central difference). */
  gy: Float32Array;
}

export type Pyramid = PyramidLevel[];

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Float32Array(width * height) };
}

/** Converts RGBA bytes (e.g. from getImageData) to luma. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, out: GrayImage): GrayImage {
  const { data } = out;
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return out;
}

/** Separable 5-tap binomial blur [1 4 6 4 1] / 16 with clamped borders. */
export function blur5(src: GrayImage, tmp: Float32Array, out: Float32Array): void {
  const { width: w, height: h, data } = src;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x < 2 ? 0 : x - 2;
      const x1 = x < 1 ? 0 : x - 1;
      const x3 = x >= w - 1 ? w - 1 : x + 1;
      const x4 = x >= w - 2 ? w - 1 : x + 2;
      tmp[row + x] =
        (data[row + x0] + 4 * data[row + x1] + 6 * data[row + x] + 4 * data[row + x3] + data[row + x4]) *
        0.0625;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = (y < 2 ? 0 : y - 2) * w;
    const y1 = (y < 1 ? 0 : y - 1) * w;
    const y2 = y * w;
    const y3 = (y >= h - 1 ? h - 1 : y + 1) * w;
    const y4 = (y >= h - 2 ? h - 1 : y + 2) * w;
    for (let x = 0; x < w; x++) {
      out[y2 + x] =
        (tmp[y0 + x] + 4 * tmp[y1 + x] + 6 * tmp[y2 + x] + 4 * tmp[y3 + x] + tmp[y4 + x]) * 0.0625;
    }
  }
}

function gradients(level: PyramidLevel): void {
  const { width: w, height: h, data, gx, gy } = level;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      gx[row + x] = (data[row + xp] - data[row + xm]) * 0.5;
      gy[row + x] = (data[yp + x] - data[ym + x]) * 0.5;
    }
  }
}

function makeLevel(width: number, height: number): PyramidLevel {
  const n = width * height;
  return { width, height, data: new Float32Array(n), gx: new Float32Array(n), gy: new Float32Array(n) };
}

let blurScratch = new Float32Array(0);
let blurredScratch = new Float32Array(0);

/**
 * Builds (or rebuilds in place, reusing buffers) a Gaussian pyramid.
 * Level 0 is a lightly smoothed copy of the input, each next level is half size.
 */
export function buildPyramid(src: GrayImage, levels: number, reuse?: Pyramid): Pyramid {
  const pyr: Pyramid =
    reuse && reuse.length === levels && reuse[0].width === src.width && reuse[0].height === src.height
      ? reuse
      : [];
  if (pyr.length === 0) {
    let w = src.width;
    let h = src.height;
    for (let l = 0; l < levels; l++) {
      pyr.push(makeLevel(w, h));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }
  const size = src.width * src.height;
  if (blurScratch.length < size) blurScratch = new Float32Array(size);
  if (blurredScratch.length < size) blurredScratch = new Float32Array(size);
  const tmp = blurScratch;
  const blurred = blurredScratch;
  blur5(src, tmp, pyr[0].data);
  gradients(pyr[0]);
  for (let l = 1; l < levels; l++) {
    const prev = pyr[l - 1];
    const cur = pyr[l];
    blur5(prev, tmp, blurred);
    const pw = prev.width;
    for (let y = 0; y < cur.height; y++) {
      for (let x = 0; x < cur.width; x++) {
        cur.data[y * cur.width + x] = blurred[2 * y * pw + 2 * x];
      }
    }
    gradients(cur);
  }
  return pyr;
}

/** Bilinear sample with clamping to the image border. */
export function sample(img: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const ax = x - x0;
  const ay = y - y0;
  const i = y0 * w + x0;
  const top = img[i] + (img[i + 1] - img[i]) * ax;
  const bot = img[i + w] + (img[i + w + 1] - img[i + w]) * ax;
  return top + (bot - top) * ay;
}

/** Deep-copies a pyramid, reusing the buffers of `into` when the shapes match. */
export function copyPyramid(src: Pyramid, into?: Pyramid | null): Pyramid {
  const same =
    into && into.length === src.length && into.every((l, i) => l.width === src[i].width && l.height === src[i].height);
  const out: Pyramid = same ? into! : src.map((l) => makeLevel(l.width, l.height));
  src.forEach((l, i) => {
    out[i].data.set(l.data);
    out[i].gx.set(l.gx);
    out[i].gy.set(l.gy);
  });
  return out;
}
