import { bmi, loadProfile, type Profile, profileSummary, sanitize, saveProfile } from '../profile';

let dialog: HTMLDialogElement | null = null;

function bmiText(p: Profile): string {
  const v = bmi(p);
  if (!v) return '';
  const band = v < 18.5 ? 'below the healthy range' : v < 25 ? 'healthy range' : v < 30 ? 'above the healthy range' : 'well above the healthy range';
  return `BMI ${v.toFixed(1)} · ${band}`;
}

/**
 * Opens the profile sheet. Resolves when it closes, with the saved profile (or the unchanged one
 * when skipped). `beforeScan` words the buttons for the one-time offer before the first scan.
 */
export function openProfileSheet(beforeScan = false): Promise<Profile> {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.id = 'profile-sheet';
    dialog.setAttribute('aria-labelledby', 'profile-title');
    document.body.append(dialog);
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog!.close();
    });
  }
  const d = dialog;
  const p = loadProfile();
  const year = new Date().getFullYear();
  const seg = (value: string, label: string) =>
    `<button type="button" role="radio" aria-checked="${(p.sex ?? '') === value}" data-sex="${value}">${label}</button>`;
  d.innerHTML = `
    <form class="sheet-inner profile-form" novalidate>
      <header class="sheet-head">
        <span class="tile-ico user-ico"></span>
        <h3 id="profile-title">Your profile</h3>
        <button type="button" class="sheet-close" aria-label="Close"><span class="x-ico"></span></button>
      </header>
      <p class="sheet-summary">Optional. It makes your results personal: training zones, HRV and resting pulse
        judged for your age and sex, and workout calories. Saved on this phone only.</p>
      <div class="field"><span>Sex</span>
        <div class="context" role="radiogroup" aria-label="Sex">${seg('female', 'Female')}${seg('male', 'Male')}${seg('', 'Skip')}</div>
      </div>
      <label class="field"><span>Birth year</span>
        <input name="birthYear" type="number" inputmode="numeric" min="${year - 100}" max="${year - 10}" placeholder="e.g. 1990" value="${p.birthYear ?? ''}" />
      </label>
      <label class="field"><span>Height</span>
        <span class="unit-input"><input name="heightCm" type="number" inputmode="numeric" min="100" max="230" placeholder="—" value="${p.heightCm ?? ''}" /><i>cm</i></span>
      </label>
      <label class="field"><span>Weight</span>
        <span class="unit-input"><input name="weightKg" type="number" inputmode="decimal" min="30" max="250" placeholder="—" value="${p.weightKg ?? ''}" /><i>kg</i></span>
      </label>
      <p class="bmi" aria-live="polite">${bmiText(p)}</p>
      <div class="actions">
        <button type="button" class="btn" data-skip>${beforeScan ? 'Skip' : 'Cancel'}</button>
        <button type="submit" class="btn primary">${beforeScan ? 'Save & start' : 'Save'}</button>
      </div>
    </form>`;
  const form = d.querySelector('form')!;
  let sex = p.sex;
  const num = (name: string) => Number((form.elements.namedItem(name) as HTMLInputElement).value) || null;
  const read = (): Profile => sanitize({ sex, birthYear: num('birthYear'), heightCm: num('heightCm'), weightKg: num('weightKg') });
  d.querySelectorAll<HTMLButtonElement>('[data-sex]').forEach((b) =>
    b.addEventListener('click', () => {
      sex = (b.dataset.sex || null) as Profile['sex'];
      d.querySelectorAll('[data-sex]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    }),
  );
  form.addEventListener('input', () => (d.querySelector('.bmi')!.textContent = bmiText(read())));
  let result = p;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    result = read();
    saveProfile(result);
    d.close();
  });
  d.querySelector('[data-skip]')!.addEventListener('click', () => d.close());
  d.querySelector('.sheet-close')!.addEventListener('click', () => d.close());
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(result), { once: true }));
}

/** Text for the profile row on the start screen. */
export function profileRowText(): string {
  return profileSummary(loadProfile()) ?? 'Add your profile (optional)';
}
