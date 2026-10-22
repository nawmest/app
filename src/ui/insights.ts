import { type Insight, insights } from '../insights/insights';
import type { ScanResult } from '../scan';

const AGE_KEY = 'pulselens-age';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Age for heart-rate zones, remembered on this device only. */
export function savedAge(): number | null {
  try {
    const v = Number(localStorage.getItem(AGE_KEY));
    return v >= 10 && v <= 100 ? v : null;
  } catch {
    return null;
  }
}

function saveAge(age: number | null): void {
  try {
    if (age === null) localStorage.removeItem(AGE_KEY);
    else localStorage.setItem(AGE_KEY, String(age));
  } catch {
    // Storage blocked: zones still work for this view.
  }
}

const pct = (v: number) => `${Math.round(Math.max(0.03, Math.min(1, v)) * 100)}%`;

function tile(i: Insight): string {
  return `
    <button type="button" class="tile ${i.key}" data-key="${i.key}" aria-haspopup="dialog">
      <span class="tile-top"><span class="tile-ico ${i.key}-ico"></span>${esc(i.title)}</span>
      <span class="tile-value tone-${i.tone}">${esc(i.value)}</span>
      <span class="tile-bar">${i.gauge ? `<i class="tone-${i.tone}" style="width:${pct(i.gauge.value)}"></i>` : ''}</span>
      <span class="tile-cap">${esc(i.caption)}</span>
    </button>`;
}

/** The insights row for the results screen. */
export function insightsHtml(r: ScanResult): string {
  return `
    <section class="insights" aria-label="Wellness insights">
      <div class="insights-head"><span class="panel-title">Wellness</span><span>Tap for details</span></div>
      <div class="tiles">${insights(r, savedAge()).map(tile).join('')}</div>
    </section>`;
}

function sheetBody(i: Insight, age: number | null): string {
  const gauge = i.gauge
    ? `<div class="gauge" role="img" aria-label="${esc(i.value)}, between ${esc(i.gauge.from)} and ${esc(i.gauge.to)}">
         <div class="gauge-track"><span class="gauge-mark" style="left:${pct(i.gauge.value)}"></span></div>
         <div class="gauge-labels"><span>${esc(i.gauge.from)}</span><span>${esc(i.gauge.to)}</span></div>
       </div>`
    : '';
  const facts = i.facts.length
    ? `<dl class="facts">${i.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
    : '';
  const sport =
    i.key === 'sport'
      ? `<label class="age-row"><span>Your age</span>
           <input id="age" type="number" inputmode="numeric" min="10" max="100" placeholder="—" value="${age ?? ''}" />
           <small>for heart-rate zones · saved on this phone only</small></label>
         ${
           i.zones
             ? `<ol class="zones">${i.zones
                 .map((z) => `<li class="${z.current ? 'current' : ''}"><span>${esc(z.name)}</span><span>${esc(z.range)}</span></li>`)
                 .join('')}</ol>`
             : ''
         }`
      : '';
  return `
    <header class="sheet-head">
      <span class="tile-ico ${i.key}-ico"></span>
      <h3 id="sheet-title">${esc(i.title)}</h3>
      <button type="button" class="sheet-close" aria-label="Close"><span class="x-ico"></span></button>
    </header>
    <div class="sheet-value tone-${i.tone}">${esc(i.value)}</div>
    <p class="sheet-cap">${esc(i.caption)}</p>
    ${gauge}
    <p class="sheet-summary">${esc(i.summary)}</p>
    ${facts}
    ${sport}
    <p class="tip">${esc(i.tip)}</p>
    <p class="sheet-note">A wellness estimate from a 30-second camera scan, not a medical measurement.</p>`;
}

/** Wires the insight tiles in `root`: each opens a bottom sheet with the details. */
export function wireInsights(root: HTMLElement, r: ScanResult): void {
  let sheet = document.getElementById('sheet') as HTMLDialogElement | null;
  if (!sheet) {
    sheet = document.createElement('dialog');
    sheet.id = 'sheet';
    sheet.className = 'sheet';
    sheet.setAttribute('aria-labelledby', 'sheet-title');
    document.body.append(sheet);
    // Tapping the dimmed backdrop closes the sheet.
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) sheet!.close();
    });
  }
  const dialog = sheet;
  const open = (key: string) => {
    const age = savedAge();
    const i = insights(r, age).find((x) => x.key === key)!;
    dialog.innerHTML = `<div class="sheet-inner">${sheetBody(i, age)}</div>`;
    dialog.querySelector('.sheet-close')!.addEventListener('click', () => dialog.close());
    const input = dialog.querySelector<HTMLInputElement>('#age');
    input?.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      saveAge(input.value === '' ? null : v >= 10 && v <= 100 ? v : savedAge());
      // Refresh the sheet and the tiles with the new zones.
      const tiles = root.querySelector('.insights');
      if (tiles) tiles.outerHTML = insightsHtml(r);
      bindTiles();
      open(key);
    });
    if (!dialog.open) dialog.showModal();
  };
  const bindTiles = () =>
    root.querySelectorAll<HTMLButtonElement>('.tile').forEach((b) => b.addEventListener('click', () => open(b.dataset.key!)));
  bindTiles();
}

/** Insight lines for the copied summary. */
export function insightsText(r: ScanResult): string[] {
  return insights(r, savedAge()).map((i) => `${i.title}: ${i.value} (${i.caption})`);
}
