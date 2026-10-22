import type { GrayImage } from './image';

/** Zero-mean, unit-norm template cut from an image. */
export interface Template {
  size: number;
  data: Float32Array;
}

export function cutTemplate(img: GrayImage, cx: number, cy: number, half: number): Template | null {
  const size = 2 * half + 1;
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  if (x0 < 0 || y0 < 0 || x0 + size > img.width || y0 + size > img.height) return null;
  const data = new Float32Array(size * size);
  let mean = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = img.data[(y0 + y) * img.width + x0 + x];
      data[y * size + x] = v;
      mean += v;
    }
  }
  mean /= data.length;
  let norm = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] -= mean;
    norm += data[i] * data[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-3 * data.length) return null; // flat patch
  for (let i = 0; i < data.length; i++) data[i] /= norm;
  return { size, data };
}

export interface Match {
  x: number;
  y: number;
  score: number;
}

/**
 * Exhaustive normalized cross-correlation search of `tpl` over `img` (template centers
 * within the optional search rectangle). Returns the best match center.
 */
export function matchTemplate(
  img: GrayImage,
  tpl: Template,
  search?: { x0: number; y0: number; x1: number; y1: number },
  step = 1,
): Match {
  const { width: w, height: h, data } = img;
  const half = (tpl.size - 1) >> 1;
  const size = tpl.size;
  const n = size * size;
  const xs = Math.max(half, Math.floor(search?.x0 ?? half));
  const ys = Math.max(half, Math.floor(search?.y0 ?? half));
  const xe = Math.min(w - half - 1, Math.ceil(search?.x1 ?? w));
  const ye = Math.min(h - half - 1, Math.ceil(search?.y1 ?? h));
  let best: Match = { x: -1, y: -1, score: -2 };
  for (let cy = ys; cy <= ye; cy += step) {
    for (let cx = xs; cx <= xe; cx += step) {
      let sum = 0;
      let sum2 = 0;
      let cross = 0;
      let k = 0;
      for (let y = 0; y < size; y++) {
        let i = (cy - half + y) * w + cx - half;
        for (let x = 0; x < size; x++, i++, k++) {
          const v = data[i];
          sum += v;
          sum2 += v * v;
          cross += v * tpl.data[k];
        }
      }
      // Template is zero-mean so the image mean drops out of the cross term.
      const varN = sum2 - (sum * sum) / n;
      if (varN <= 1e-6) continue;
      const score = cross / Math.sqrt(varN);
      if (score > best.score) best = { x: cx, y: cy, score };
    }
  }
  return best;
}
