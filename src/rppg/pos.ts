/**
 * POS ("Plane-Orthogonal-to-Skin") rPPG algorithm — W. Wang, A. C. den Brinker, S. Stuijk and
 * G. de Haan, "Algorithmic Principles of Remote PPG", IEEE TBME 64(7), 2017.
 *
 * The mean skin colour (R, G, B) is temporally normalised over short windows, projected onto two
 * axes orthogonal to the skin tone, and the two projections are combined with an adaptive weight
 * that cancels most intensity and specular (motion / lighting) variation. Window outputs are
 * overlap-added into a continuous pulse signal.
 */
export function pos(r: ArrayLike<number>, g: ArrayLike<number>, b: ArrayLike<number>, fs: number, windowSec = 1.6): Float64Array {
  const n = r.length;
  const h = new Float64Array(n);
  const l = Math.max(2, Math.round(windowSec * fs));
  const s0 = new Float64Array(l);
  const s1 = new Float64Array(l);
  for (let end = l; end <= n; end++) {
    const m = end - l;
    let mr = 0, mg = 0, mb = 0;
    for (let i = m; i < end; i++) {
      mr += r[i];
      mg += g[i];
      mb += b[i];
    }
    mr /= l;
    mg /= l;
    mb /= l;
    if (mr <= 0 || mg <= 0 || mb <= 0) continue;
    let a0 = 0, a1 = 0;
    for (let i = 0; i < l; i++) {
      const cr = r[m + i] / mr;
      const cg = g[m + i] / mg;
      const cb = b[m + i] / mb;
      s0[i] = cg - cb;
      s1[i] = -2 * cr + cg + cb;
      a0 += s0[i];
      a1 += s1[i];
    }
    a0 /= l;
    a1 /= l;
    let v0 = 0, v1 = 0;
    for (let i = 0; i < l; i++) {
      v0 += (s0[i] - a0) ** 2;
      v1 += (s1[i] - a1) ** 2;
    }
    const alpha = v1 > 0 ? Math.sqrt(v0 / v1) : 0;
    let hm = 0;
    for (let i = 0; i < l; i++) hm += s0[i] + alpha * s1[i];
    hm /= l;
    for (let i = 0; i < l; i++) h[m + i] += s0[i] + alpha * s1[i] - hm;
  }
  return h;
}
