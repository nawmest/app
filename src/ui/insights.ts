import { type Insight, insights, isAfterExercise } from '../insights/insights';
import { loadProfile, person } from '../profile';
import type { ScanResult } from '../scan';
import { openProfileSheet } from './profile';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const who = () => person(loadProfile());

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

/**
 * The insights row for the results screen. `exercised` says whether the scan was right after
 * exercise: detected from the heart rate, and the person can correct it.
 */
export function insightsHtml(r: ScanResult, exercised = isAfterExercise(r)): string {
  const opt = (value: boolean, label: string) =>
    `<button type="button" role="radio" aria-checked="${exercised === value}" data-exercised="${value}">${label}</button>`;
  return `
    <section class="insights" aria-label="Wellness insights">
      <div class="insights-head">
        <span class="panel-title">Wellness</span>
        <div class="context" role="radiogroup" aria-label="When was this scan?">${opt(false, 'At rest')}${opt(true, 'Just exercised')}</div>
      </div>
      <div class="tiles">${insights(r, who(), exercised).map(tile).join('')}</div>
      <p class="insights-hint">Tap a tile for details</p>
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
      ? `${
          i.zones
            ? `<ol class="zones">${i.zones
                .map((z) => `<li class="${z.current ? 'current' : ''}"><span>${esc(z.name)}</span><span>${esc(z.range)}</span></li>`)
                .join('')}</ol>`
            : ''
        }
        <button type="button" class="link-btn" data-profile>${age === null ? 'Add your birth year for heart-rate zones' : 'Edit your profile'}</button>`
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

/**
 * Wires the insights in `root`: the rest/exercise switch, and tiles that each open a bottom
 * sheet with the details. `onContext` is told when the person changes the switch.
 */
export function wireInsights(
  root: HTMLElement,
  r: ScanResult,
  onContext?: (exercised: boolean) => void,
  onProfile?: () => void,
): void {
  let exercised = isAfterExercise(r);
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
    const p = who();
    const i = insights(r, p, exercised).find((x) => x.key === key)!;
    dialog.innerHTML = `<div class="sheet-inner">${sheetBody(i, p.age)}</div>`;
    dialog.querySelector('.sheet-close')!.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-profile]')?.addEventListener('click', async () => {
      dialog.close();
      await openProfileSheet();
      // Refresh the tiles and this sheet with the personal ranges.
      refresh();
      onProfile?.();
      open(key);
    });
    if (!dialog.open) dialog.showModal();
  };
  const bind = () => {
    root.querySelectorAll<HTMLButtonElement>('.tile').forEach((b) => b.addEventListener('click', () => open(b.dataset.key!)));
    root.querySelectorAll<HTMLButtonElement>('.context button').forEach((b) =>
      b.addEventListener('click', () => {
        const value = b.dataset.exercised === 'true';
        if (value === exercised) return;
        exercised = value;
        refresh();
        onContext?.(exercised);
      }),
    );
  };
  const refresh = () => {
    const section = root.querySelector('.insights');
    if (section) section.outerHTML = insightsHtml(r, exercised);
    bind();
  };
  bind();
}

/** Insight lines for the copied summary. */
export function insightsText(r: ScanResult, exercised = isAfterExercise(r)): string[] {
  return [
    `Context: ${exercised ? 'just exercised' : 'at rest'}`,
    ...insights(r, who(), exercised).map((i) => `${i.title}: ${i.value} (${i.caption})`),
  ];
}
