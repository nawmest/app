import { clearHistory, type HistoryEntry, loadHistory, restingAverage } from '../history';

const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Dots and a line of values over time (one point per scan), with a few value and date labels. */
function drawSeries(canvas: HTMLCanvasElement, pts: [number, number][], color: string): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  const vs = pts.map((p) => p[1]);
  const lo = Math.floor(Math.min(...vs) / 5) * 5 - 5;
  const hi = Math.ceil(Math.max(...vs) / 5) * 5 + 5;
  const t0 = pts[0][0];
  const t1 = Math.max(pts[pts.length - 1][0], t0 + 1);
  const pad = { l: 30, r: 12, t: 8, b: 20 };
  // Evenly spaced by scan when the dates are bunched; by time otherwise.
  const byIndex = pts.length > 1 && t1 - t0 < 2 * 86400000;
  const x = (i: number) => pad.l + (byIndex || pts.length < 2 ? i / Math.max(1, pts.length - 1) : (pts[i][0] - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  ctx.font = '11px "Inter Variable", system-ui, sans-serif';
  ctx.fillStyle = '#5d6a82';
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [lo, (lo + hi) / 2, hi]) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v) + 0.5);
    ctx.lineTo(w - pad.r, y(v) + 0.5);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), pad.l - 6, y(v));
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(fmtDay(pts[0][0]), pad.l, h - 4);
  ctx.textAlign = 'right';
  if (pts.length > 1) ctx.fillText(fmtDay(pts[pts.length - 1][0]), w - pad.r, h - 4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach(([, v], i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
  ctx.fillStyle = color;
  pts.forEach(([, v], i) => {
    ctx.beginPath();
    ctx.arc(x(i), y(v), i === pts.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function row(e: HistoryEntry): string {
  return `
    <li>
      <div class="h-when"><b>${fmtDay(e.at)}</b><span>${fmtTime(e.at)} · ${e.durationSec} s</span></div>
      <span class="h-tag ${e.exercised ? 'workout' : ''}">${e.exercised ? 'Workout' : 'Rest'}</span>
      <div class="h-vals">
        <span><b>${Math.round(e.heartRate)}</b> bpm</span>
        <span>${e.rmssd !== null ? `<b>${e.rmssd}</b> ms` : '<b>—</b> HRV'}</span>
        <span>${e.respiration !== null ? `<b>${Math.round(e.respiration)}</b> /min` : '<b>—</b> /min'}</span>
      </div>
    </li>`;
}

/** Renders the history screen into `root`. `onBack` returns to the start screen. */
export function renderHistory(root: HTMLElement, onBack: () => void): void {
  const list = loadHistory();
  const rest = list.filter((e) => !e.exercised);
  const hrv = rest.filter((e) => e.rmssd !== null);
  const avg = restingAverage(list);
  root.innerHTML = `
    <div class="res-head">
      <div>
        <button type="button" class="link-btn back" id="history-back">‹ Back</button>
        <h2>History</h2>
      </div>
      <span class="h-count">${list.length} scan${list.length === 1 ? '' : 's'}</span>
    </div>
    ${
      list.length
        ? `
    <section class="panel">
      <div class="panel-title"><span class="heart-ico" style="color:var(--hr)"></span>Resting heart rate</div>
      ${
        avg
          ? `<div class="big"><span class="num">${Math.round(avg.bpm)}</span><span class="unit">bpm</span></div>
             <p class="mini-note">Average of ${avg.scans} resting scan${avg.scans === 1 ? '' : 's'} in the last 7 days. A falling resting pulse over weeks usually means improving fitness.</p>`
          : '<p class="mini-note">No resting scans in the last 7 days.</p>'
      }
      ${rest.length > 1 ? '<canvas class="h-chart" id="h-hr" aria-label="Resting heart rate over time"></canvas>' : ''}
    </section>
    ${
      hrv.length > 1
        ? `<section class="panel">
             <div class="panel-title"><span class="wave-ico" style="color:var(--hrv)"></span>HRV · RMSSD at rest</div>
             <canvas class="h-chart" id="h-hrv" aria-label="HRV over time"></canvas>
             <p class="mini-note">Higher than your usual means well recovered; a dip often follows hard training, stress or poor sleep.</p>
           </section>`
        : ''
    }
    <ul class="h-list">${list.slice().reverse().map(row).join('')}</ul>
    <button type="button" class="btn" id="history-clear">Clear history</button>
    <p class="disclaimer">Saved on this phone only.</p>`
        : `<section class="panel"><p class="mini-note">No scans yet. Each scan you finish is saved here, on this phone only, so you can follow your resting heart rate and HRV over time.</p></section>`
    }`;
  root.querySelector('#history-back')!.addEventListener('click', onBack);
  root.querySelector('#history-clear')?.addEventListener('click', () => {
    if (confirm('Delete all saved scans from this phone?')) {
      clearHistory();
      renderHistory(root, onBack);
    }
  });
  requestAnimationFrame(() => {
    const hr = root.querySelector<HTMLCanvasElement>('#h-hr');
    if (hr) drawSeries(hr, rest.slice(-30).map((e) => [e.at, e.heartRate]), '#ff5470');
    const hv = root.querySelector<HTMLCanvasElement>('#h-hrv');
    if (hv) drawSeries(hv, hrv.slice(-30).map((e) => [e.at, e.rmssd!]), '#a88bff');
  });
}

/** Text for the history row on the start screen. */
export function historyRowText(): string {
  const n = loadHistory().length;
  return n ? `History · ${n} scan${n === 1 ? '' : 's'}` : 'History';
}
