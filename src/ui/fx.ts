import { FACE_OVAL, TESSELATION, type FaceFrame } from '../face/landmarker';
import { REGIONS, type RegionName, convexHull, type Pt } from '../face/regions';
import type { GuidanceCode, Phase } from '../scan';

/** Maps video pixels to CSS pixels for an `object-fit: cover`, mirrored (selfie) video. */
export class ViewMap {
  scale = 1;
  left = 0;
  top = 0;
  constructor(
    public vw = 1,
    public vh = 1,
    public cw = 1,
    public ch = 1,
  ) {}
  update(vw: number, vh: number, cw: number, ch: number): void {
    Object.assign(this, { vw, vh, cw, ch });
    this.scale = Math.max(cw / vw, ch / vh);
    this.left = (cw - vw * this.scale) / 2;
    this.top = (ch - vh * this.scale) / 2;
  }
  x(px: number): number {
    return this.left + (this.vw - px) * this.scale;
  }
  y(py: number): number {
    return this.top + py * this.scale;
  }
}

export interface FxInput {
  /** Seconds (performance clock). */
  now: number;
  dt: number;
  phase: Phase;
  guidance: GuidanceCode;
  progress: number;
  face: FaceFrame | null;
  /** 0..1, decays after each heartbeat (drives the skin glow). */
  pulse: number;
  /** Seconds since the scan started (lock-on animation), or null. */
  scanAge: number | null;
  /** How long the face has been aligned (0..1 of the hold time). */
  alignHold: number;
}

export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardLayout {
  hr: CardBox;
  resp: CardBox;
  hrv: CardBox;
  visible: boolean;
}

const COLORS = {
  accent: [76, 242, 210],
  accent2: [94, 182, 255],
  hr: [255, 84, 112],
  resp: [94, 182, 255],
  hrv: [168, 139, 255],
  warn: [255, 181, 71],
};
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Orders the face-oval connection pairs into a closed loop of landmark indices. */
function ovalOrder(): number[] {
  const next = new Map<number, number>();
  for (const c of FACE_OVAL) next.set(c.start, c.end);
  const start = FACE_OVAL[0].start;
  const order = [start];
  for (let i = next.get(start)!; i !== start && order.length < 200; i = next.get(i)!) order.push(i);
  return order;
}

/**
 * Canvas AR layer over the selfie video: alignment guide, face mesh with a sweeping scan band,
 * pulse-synchronised glow on the measurement regions, lock-on brackets, a progress ring around the
 * face, and leader lines to the floating metric cards (whose positions it also computes).
 */
export class FxRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  readonly map = new ViewMap();
  private dpr = 1;
  private disp: Float32Array | null = null;
  private faceAlpha = 0;
  private readonly oval = ovalOrder();
  private readonly edges = TESSELATION.map((c) => [c.start, c.end] as const);
  private cards: CardLayout | null = null;
  private bbox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private guideColor = [...COLORS.warn];
  /** Visual detail: 0 = full, 1 = reduced, 2 = minimal (set by the performance governor). */
  detail = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssW: number, cssH: number, vw: number, vh: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(cssW * this.dpr);
    const h = Math.round(cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.map.update(vw, vh, cssW, cssH);
  }

  /** Draws a frame. `cardSizes` are the measured card sizes; returns where to put the cards. */
  render(input: FxInput, cardSizes: { w: number; h: number }[]): CardLayout | null {
    const { ctx, map } = this;
    const W = map.cw;
    const H = map.ch;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Smooth the landmarks for display (detection jitter), fade the face layer in/out.
    const face = input.face;
    const kPos = 1 - Math.exp(-input.dt * 22);
    if (face) {
      if (!this.disp || this.disp.length !== (face.points.length / 3) * 2) {
        this.disp = new Float32Array((face.points.length / 3) * 2);
        for (let i = 0; i < this.disp.length / 2; i++) {
          this.disp[2 * i] = face.points[3 * i];
          this.disp[2 * i + 1] = face.points[3 * i + 1];
        }
      }
      for (let i = 0; i < this.disp.length / 2; i++) {
        this.disp[2 * i] += (face.points[3 * i] - this.disp[2 * i]) * kPos;
        this.disp[2 * i + 1] += (face.points[3 * i + 1] - this.disp[2 * i + 1]) * kPos;
      }
    }
    this.faceAlpha += ((face ? 1 : 0) - this.faceAlpha) * (1 - Math.exp(-input.dt * (face ? 8 : 4)));

    const scanning = input.phase === 'scanning';
    if (input.phase === 'searching' || input.phase === 'aligning') this.drawGuide(input, W, H);

    let layout: CardLayout | null = null;
    if (this.disp && this.faceAlpha > 0.02) {
      const pts = this.screenPoints();
      this.updateBBox(pts);
      ctx.save();
      ctx.globalAlpha = this.faceAlpha;
      this.drawMesh(pts, input);
      if (scanning) this.drawRegions(pts, input.pulse);
      this.drawOval(pts, input, scanning);
      this.drawBrackets(input);
      if (scanning) this.drawProgress(input);
      ctx.restore();
      if (scanning) {
        layout = this.layoutCards(W, H, cardSizes, input.dt);
        ctx.save();
        ctx.globalAlpha = this.faceAlpha;
        this.drawLeaders(pts, layout);
        ctx.restore();
      }
    }
    if (!layout && this.cards) this.cards = { ...this.cards, visible: false };
    return layout ?? this.cards;
  }

  private screenPoints(): Float32Array {
    const d = this.disp!;
    const out = new Float32Array(d.length);
    for (let i = 0; i < d.length / 2; i++) {
      out[2 * i] = this.map.x(d[2 * i]);
      out[2 * i + 1] = this.map.y(d[2 * i + 1]);
    }
    return out;
  }

  private updateBBox(pts: Float32Array): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of this.oval) {
      x0 = Math.min(x0, pts[2 * i]);
      x1 = Math.max(x1, pts[2 * i]);
      y0 = Math.min(y0, pts[2 * i + 1]);
      y1 = Math.max(y1, pts[2 * i + 1]);
    }
    this.bbox = { x0, y0, x1, y1 };
  }

  /** Target oval and dial while the user lines up their face. */
  private drawGuide(input: FxInput, W: number, H: number): void {
    const { ctx } = this;
    const cx = W / 2;
    const cy = H * 0.46;
    const rx = Math.min(W * 0.31, H * 0.24);
    const ry = rx * 1.3;
    const ok = input.guidance === 'ok';
    const target = ok ? COLORS.accent : input.face ? COLORS.warn : [200, 210, 225];
    for (let i = 0; i < 3; i++) this.guideColor[i] += (target[i] - this.guideColor[i]) * Math.min(1, input.dt * 6);
    const col = this.guideColor;
    const t = input.now;
    ctx.save();
    // Dim everything outside the oval.
    ctx.fillStyle = 'rgba(3,6,12,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    // Dial ticks around the oval.
    const n = this.detail ? 60 : 90;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const filled = ok && i / n < input.alignHold;
      const wave = 0.5 + 0.5 * Math.sin(a * 3 - t * 3);
      const len = filled ? 12 : 6 + 3 * wave;
      const r0x = rx + 10;
      const r0y = ry + 10;
      ctx.strokeStyle = rgba(col, filled ? 0.95 : 0.25 + 0.25 * wave);
      ctx.lineWidth = filled ? 2.4 : 1.4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0x, cy + Math.sin(a) * r0y);
      ctx.lineTo(cx + Math.cos(a) * (r0x + len), cy + Math.sin(a) * (r0y + len));
      ctx.stroke();
    }
    ctx.setLineDash([2, 7]);
    ctx.lineDashOffset = -t * 18;
    ctx.strokeStyle = rgba(col, 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawMesh(pts: Float32Array, input: FxInput): void {
    const { ctx } = this;
    const { y0, y1 } = this.bbox;
    const fh = Math.max(1, y1 - y0);
    // Scan band sweeping over the face (faster and brighter while measuring).
    const scanning = input.phase === 'scanning';
    const period = scanning ? 2.6 : 3.4;
    const ph = (input.now % period) / period;
    const sweep = y0 + fh * (ph < 0.5 ? ph * 2 : 2 - ph * 2) * 1.1 - fh * 0.05;
    const width = fh * 0.13;
    const base = scanning ? 0.1 : 0.07;
    const LEVELS = 6;
    const buckets: number[][] = Array.from({ length: LEVELS }, () => []);
    const stride = this.detail + 1;
    for (let e = 0; e < this.edges.length; e += stride) {
      const [a, b] = this.edges[e];
      const my = (pts[2 * a + 1] + pts[2 * b + 1]) / 2;
      const k = Math.exp(-(((my - sweep) / width) ** 2));
      const level = Math.min(LEVELS - 1, Math.floor(k * LEVELS));
      buckets[level].push(a, b);
    }
    ctx.lineWidth = 0.7;
    for (let l = 0; l < LEVELS; l++) {
      const list = buckets[l];
      if (!list.length) continue;
      ctx.strokeStyle = rgba(COLORS.accent, base + (l / (LEVELS - 1)) * 0.65);
      ctx.beginPath();
      for (let i = 0; i < list.length; i += 2) {
        ctx.moveTo(pts[2 * list[i]], pts[2 * list[i] + 1]);
        ctx.lineTo(pts[2 * list[i + 1]], pts[2 * list[i + 1] + 1]);
      }
      ctx.stroke();
    }
    // Bright vertices inside the band.
    ctx.fillStyle = rgba([220, 255, 248], 0.9);
    for (let i = 0; i < pts.length / 2; i += stride) {
      const k = Math.exp(-(((pts[2 * i + 1] - sweep) / (width * 0.6)) ** 2));
      if (k < 0.25) continue;
      const s = 1.1 + 1.2 * k;
      ctx.globalAlpha = this.faceAlpha * k;
      ctx.fillRect(pts[2 * i] - s / 2, pts[2 * i + 1] - s / 2, s, s);
    }
    ctx.globalAlpha = this.faceAlpha;
    // The band itself, clipped to the face.
    ctx.save();
    this.ovalPath(pts);
    ctx.clip();
    const g = ctx.createLinearGradient(0, sweep - width, 0, sweep + width);
    g.addColorStop(0, rgba(COLORS.accent, 0));
    g.addColorStop(0.5, rgba(COLORS.accent, scanning ? 0.16 : 0.1));
    g.addColorStop(1, rgba(COLORS.accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(this.bbox.x0 - 4, sweep - width, this.bbox.x1 - this.bbox.x0 + 8, 2 * width);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(COLORS.accent, 0.55);
    ctx.fillRect(this.bbox.x0 - 4, sweep - 0.75, this.bbox.x1 - this.bbox.x0 + 8, 1.5);
    ctx.restore();
  }

  private ovalPath(pts: Float32Array): void {
    const { ctx } = this;
    ctx.beginPath();
    this.oval.forEach((i, k) => (k ? ctx.lineTo(pts[2 * i], pts[2 * i + 1]) : ctx.moveTo(pts[2 * i], pts[2 * i + 1])));
    ctx.closePath();
  }

  private drawOval(pts: Float32Array, input: FxInput, scanning: boolean): void {
    const { ctx } = this;
    const col = scanning ? COLORS.accent : input.guidance === 'ok' ? COLORS.accent : COLORS.warn;
    this.ovalPath(pts);
    ctx.strokeStyle = rgba(col, 0.18);
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.85);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /** Forehead and cheeks glow with every heartbeat. */
  private drawRegions(pts: Float32Array, pulse: number): void {
    const { ctx } = this;
    for (const name of Object.keys(REGIONS) as RegionName[]) {
      const poly = convexHull(REGIONS[name].map((i) => [pts[2 * i], pts[2 * i + 1]] as Pt));
      ctx.beginPath();
      poly.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = rgba(COLORS.hr, 0.07 + 0.3 * pulse);
      ctx.fill();
      ctx.strokeStyle = rgba(COLORS.hr, 0.35 + 0.4 * pulse);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** HUD corner brackets; they snap in from wide when the scan locks on. */
  private drawBrackets(input: FxInput): void {
    const { ctx } = this;
    const { x0, y0, x1, y1 } = this.bbox;
    const age = input.scanAge;
    const k = age === null ? 1 : Math.min(1, age / 0.6);
    const ease = 1 - Math.pow(1 - k, 3);
    const grow = 1 + (1 - ease) * 0.5;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hw = ((x1 - x0) / 2) * 1.18 * grow;
    const hh = ((y1 - y0) / 2) * 1.1 * grow;
    const len = Math.min(hw, hh) * 0.28;
    const col = input.phase === 'scanning' ? COLORS.accent : input.guidance === 'ok' ? COLORS.accent : COLORS.warn;
    ctx.strokeStyle = rgba(col, 0.9 * (age === null ? 0.7 : ease));
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const px = cx + sx * hw;
      const py = cy + sy * hh;
      ctx.moveTo(px - sx * len, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py - sy * len);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Segmented ring around the face showing scan progress. */
  private drawProgress(input: FxInput): void {
    const { ctx } = this;
    const { x0, y0, x1, y1 } = this.bbox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = ((x1 - x0) / 2) * 1.32;
    const ry = ((y1 - y0) / 2) * 1.2;
    const n = 96;
    const done = input.progress * n;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const on = i < done;
      const t = i / n;
      const c = on ? COLORS.accent.map((v, j) => v + (COLORS.accent2[j] - v) * t) : [255, 255, 255];
      ctx.strokeStyle = rgba(c, on ? 0.95 : 0.14);
      ctx.lineWidth = on ? 2.6 : 1.6;
      const r = on ? 9 : 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      ctx.lineTo(cx + Math.cos(a) * (rx + r), cy + Math.sin(a) * (ry + r));
      ctx.stroke();
    }
    // Leading dot.
    const a = input.progress * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * (rx + 4.5);
    const py = cy + Math.sin(a) * (ry + 4.5);
    const g = ctx.createRadialGradient(px, py, 0, px, py, 14);
    g.addColorStop(0, rgba(COLORS.accent2, 0.9));
    g.addColorStop(1, rgba(COLORS.accent2, 0));
    ctx.fillStyle = g;
    ctx.fillRect(px - 14, py - 14, 28, 28);
  }

  /** Places the metric cards beside the face, clear of the top bar and the dock. */
  private layoutCards(W: number, H: number, sizes: { w: number; h: number }[], dt: number): CardLayout {
    const { x0, y0, x1, y1 } = this.bbox;
    const fh = y1 - y0;
    const top = 112;
    const bottom = H - 130;
    const [hrS, respS, hrvS] = sizes;
    const clampY = (y: number, h: number) => Math.max(top, Math.min(bottom - h, y));
    const clampX = (x: number, w: number) => Math.max(10, Math.min(W - 10 - w, x));
    const target: CardLayout = {
      hr: { x: clampX(x0 - hrS.w * 0.85, hrS.w), y: clampY(y0 + fh * 0.36 - hrS.h / 2, hrS.h), ...hrS },
      resp: { x: clampX(x1 - respS.w * 0.15, respS.w), y: clampY(y0 + fh * 0.08, respS.h), ...respS },
      hrv: { x: 0, y: 0, ...hrvS },
      visible: true,
    };
    target.hrv.x = clampX(x1 - hrvS.w * 0.15, hrvS.w);
    target.hrv.y = clampY(target.resp.y + respS.h + 12 + fh * 0.12, hrvS.h);
    if (!this.cards || !this.cards.visible) {
      this.cards = target;
      return target;
    }
    const k = 1 - Math.exp(-dt * 7);
    for (const key of ['hr', 'resp', 'hrv'] as const) {
      const c = this.cards[key];
      const t = target[key];
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      c.w = t.w;
      c.h = t.h;
    }
    this.cards.visible = true;
    return this.cards;
  }

  /** Thin elbow lines from points on the face to the cards. */
  private drawLeaders(pts: Float32Array, cards: CardLayout): void {
    const { ctx } = this;
    const centroid = (name: RegionName): Pt => {
      let x = 0, y = 0;
      for (const i of REGIONS[name]) {
        x += pts[2 * i];
        y += pts[2 * i + 1];
      }
      return [x / REGIONS[name].length, y / REGIONS[name].length];
    };
    const cheeks = [centroid('leftCheek'), centroid('rightCheek')].sort((a, b) => a[0] - b[0]);
    const nose: Pt = [pts[2 * 1], pts[2 * 1 + 1]];
    const lines: [Pt, CardBox, number[], 'left' | 'right'][] = [
      [cheeks[0], cards.hr, COLORS.hr, 'left'],
      [nose, cards.resp, COLORS.resp, 'right'],
      [cheeks[1], cards.hrv, COLORS.hrv, 'right'],
    ];
    for (const [a, card, col, side] of lines) {
      const ex = side === 'left' ? card.x + card.w : card.x;
      const ey = card.y + card.h / 2;
      // Skip when the anchor is hidden behind the card.
      if (a[0] > card.x && a[0] < card.x + card.w && a[1] > card.y && a[1] < card.y + card.h) continue;
      const mx = (a[0] + ex) / 2;
      ctx.strokeStyle = rgba(col, 0.75);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(mx, ey);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = rgba(col, 1);
      ctx.beginPath();
      ctx.arc(a[0], a[1], 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(col, 0.4);
      ctx.beginPath();
      ctx.arc(a[0], a[1], 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
