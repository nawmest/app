import type { ScanResult } from '../scan';

interface Status {
  text: string;
  /** Compact form for the live cards. */
  short?: string;
  tone: 'ok' | 'warn' | 'muted';
}

/** Plain-language context for a resting heart rate (adults). */
export function heartRateStatus(bpm: number): Status & { short: string } {
  if (bpm < 50) return { text: 'Below typical resting range', short: 'Below typical', tone: 'warn' };
  if (bpm <= 100) return { text: 'Within typical resting range', short: 'Typical range', tone: 'ok' };
  return { text: 'Above typical resting range', short: 'Above typical', tone: 'warn' };
}

export function respirationStatus(rpm: number): Status {
  if (rpm < 10) return { text: 'Slower than typical', tone: 'warn' };
  if (rpm <= 20) return { text: 'Typical at rest', tone: 'ok' };
  return { text: 'Faster than typical', tone: 'warn' };
}

/** RMSSD varies a lot with age and fitness; these bands are only a rough guide for adults. */
export function hrvStatus(rmssd: number): Status {
  if (rmssd < 20) return { text: 'On the lower side', tone: 'warn' };
  if (rmssd <= 80) return { text: 'Typical range', tone: 'ok' };
  return { text: 'On the higher side', tone: 'ok' };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function rangeBar(value: number, min: number, max: number, lo: number, hi: number, color: string): string {
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return `
    <div class="range" role="img" aria-label="${value.toFixed(0)} on a scale from ${min} to ${max}; typical ${lo} to ${hi}">
      <div class="band" style="left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%"></div>
      <div class="marker" style="left:${pct(value)}%;color:${color}"></div>
    </div>
    <div class="range-labels"><span>${min}</span><span>typical ${lo}–${hi}</span><span>${max}</span></div>`;
}

const pill = (s: Status) => `<span class="status-pill ${s.tone === 'ok' ? '' : s.tone}">${esc(s.text)}</span>`;

/** Builds the results screen. Returns the trend canvas to draw into. */
export function renderResults(root: HTMLElement, r: ScanResult): HTMLCanvasElement {
  const hr = Math.round(r.heartRate);
  const q = Math.round(r.quality * 100);
  const time = r.finishedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const qText = q >= 70 ? 'Excellent' : q >= 50 ? 'Good' : q >= 30 ? 'Fair' : 'Poor';
  root.innerHTML = `
    <div class="res-head">
      <div>
        <p class="eyebrow">Scan complete</p>
        <h2>Your vitals</h2>
      </div>
      <time datetime="${r.finishedAt.toISOString()}">Today, ${esc(time)}</time>
    </div>

    <section class="panel hero">
      <div class="panel-title"><span class="heart-ico" style="color:var(--hr)"></span>Heart rate</div>
      <div class="big"><span class="num">${hr}</span><span class="unit">bpm</span></div>
      ${pill(heartRateStatus(hr))}
      ${rangeBar(hr, 40, 140, 60, 100, 'var(--hr)')}
      <canvas id="trend" aria-label="Heart rate during the scan"></canvas>
      <p class="mini-note">Varied between ${Math.round(r.heartRateRange[0])} and ${Math.round(r.heartRateRange[1])} bpm over the last 15 seconds.</p>
    </section>

    <div class="grid2">
      <section class="panel">
        <div class="panel-title"><span class="lungs-ico" style="color:var(--resp)"></span>Breathing</div>
        ${
          r.respiration
            ? `<div class="big"><span class="num">${Math.round(r.respiration)}</span><span class="unit">/min</span></div>${pill(respirationStatus(r.respiration))}`
            : `<div class="big"><span class="num">—</span></div>${pill({ text: 'Not enough signal', tone: 'muted' })}`
        }
      </section>
      <section class="panel">
        <div class="panel-title"><span class="wave-ico" style="color:var(--hrv)"></span>HRV · RMSSD</div>
        ${
          r.hrv
            ? `<div class="big"><span class="num">${Math.round(r.hrv.rmssd)}</span><span class="unit">ms</span></div>${pill(hrvStatus(r.hrv.rmssd))}`
            : `<div class="big"><span class="num">—</span></div>${pill({ text: 'Needs a steadier signal', tone: 'muted' })}`
        }
      </section>
    </div>

    <section class="panel">
      <div class="quality-row">
        <div class="panel-title">Signal quality</div>
        <strong>${qText}</strong>
      </div>
      <div class="meter" style="margin-top:10px"><i style="width:${q}%"></i></div>
      <p class="mini-note">${
        q >= 50
          ? 'Steady signal: these readings are as reliable as a camera scan gets.'
          : 'A noisy signal: for a better reading, sit still in even, bright light facing the camera.'
      }</p>
    </section>

    <p class="disclaimer">
      PulseLens estimates vital signs from subtle skin colour changes (remote photoplethysmography).
      It is a wellness demo, not a medical device, and must not be used for diagnosis or treatment.
      Accuracy drops with motion, poor or flickering light and heavy makeup. If you feel unwell,
      contact a healthcare professional.
    </p>

    <div class="actions">
      <button class="btn" id="btn-copy" type="button">Copy summary</button>
      <button class="btn primary" id="btn-again" type="button">Scan again</button>
    </div>
  `;
  return root.querySelector('#trend') as HTMLCanvasElement;
}

/** Heart rate over the scan as a smooth area chart. */
export function drawTrend(canvas: HTMLCanvasElement, trend: [number, number][], durationSec: number): void {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width;
  const h = r.height;
  if (trend.length < 2) return;
  const hrs = trend.map((p) => p[1]);
  const lo = Math.floor(Math.min(...hrs) / 5) * 5 - 5;
  const hi = Math.ceil(Math.max(...hrs) / 5) * 5 + 5;
  const pad = { l: 28, r: 16, t: 8, b: 18 };
  const x = (t: number) => pad.l + (t / durationSec) * (w - pad.l - pad.r);
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const s of [0, durationSec / 2, durationSec]) ctx.fillText(`${Math.round(s)}s`, x(s), h - 3);
  const line = new Path2D();
  trend.forEach(([t, v], i) => (i ? line.lineTo(x(t), y(v)) : line.moveTo(x(t), y(v))));
  const area = new Path2D(line);
  area.lineTo(x(trend[trend.length - 1][0]), h - pad.b);
  area.lineTo(x(trend[0][0]), h - pad.b);
  area.closePath();
  const g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  g.addColorStop(0, 'rgba(255,84,112,0.35)');
  g.addColorStop(1, 'rgba(255,84,112,0)');
  ctx.fillStyle = g;
  ctx.fill(area);
  ctx.strokeStyle = '#ff5470';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke(line);
}

export function summaryText(r: ScanResult): string {
  const lines = [
    `PulseLens scan, ${r.finishedAt.toLocaleString()}`,
    `Heart rate: ${Math.round(r.heartRate)} bpm`,
    `Breathing: ${r.respiration ? `${Math.round(r.respiration)} breaths/min` : 'not measured'}`,
    `HRV (RMSSD): ${r.hrv ? `${Math.round(r.hrv.rmssd)} ms` : 'not measured'}`,
    `Signal quality: ${Math.round(r.quality * 100)}%`,
    'Camera-based estimate for wellness only, not a medical measurement.',
    `PulseLens ${__BUILD__}`,
  ];
  return lines.join('\n');
}
