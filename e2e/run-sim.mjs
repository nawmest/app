// Companion end-to-end test in the simulator (a virtual room with a table, stool, crate and
// shelf; surfaces are sensed with rays like WebXR hit-tests). Places the virtual code on the
// table, looks around to map the room, then calls the companion to other surfaces and checks
// that it gets there, jumping where needed.
//
//   npm run build && npm run e2e:sim
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const out = resolve('test-output');
await mkdir(out, { recursive: true });
const server = await serve();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(server.url);

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const state = () => page.evaluate(() => window.__tripoint.sim.companion);
const follow = async (az = 0.7, polar = 0.95, dist = 1.6) => {
  const s = await state();
  if (s) await page.evaluate(({ az, polar, dist, p }) => window.__tripoint.sim.orbit(az, polar, dist, p), { az, polar, dist, p: s.pos });
};

await page.click('#btn-sim');
await page.waitForTimeout(500);
for (const p of [[-0.05, 0.75, -0.05], [0.15, 0.75, -0.05], [-0.05, 0.75, 0.15]]) {
  await page.evaluate((p) => window.__tripoint.sim.tap(p), p);
  await page.waitForTimeout(150);
}
await page.waitForFunction(() => window.__tripoint.sim.companion?.anim === 'Wave', null, { timeout: 15000 }).catch(() => {});
let s = await state();
check(Math.abs(s.pos[1] - 0.75) < 0.02 && s.anim === 'Wave', `companion appears on the table and waves (y=${s.pos[1].toFixed(2)}, ${s.anim})`);
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'sim-1-spawn.png') });

// Look around the room so the simulated AR system maps it.
for (let k = 0; k < 30; k++) {
  await page.evaluate((k) => window.__tripoint.sim.orbit(k * 0.22, 0.85 + 0.35 * Math.sin(k * 0.7), 2.4, [0, 0.5, 0]), k);
  await page.waitForTimeout(200);
}
s = await state();
const heights = s.surfaces.map((x) => x.y);
check(s.surfaces.length >= 3, `looking around maps several surfaces (${heights.join(', ')})`);
check(s.surfaces.filter((x) => Math.abs(x.y) < 0.02).length === 1, 'floor pieces merge into one floor');

async function callTo(name, point, expectY, shotName) {
  await follow();
  await page.evaluate((p) => window.__tripoint.sim.tap(p), point);
  let jumped = false;
  let shot = false;
  for (let i = 0; i < 160; i++) {
    await page.waitForTimeout(200);
    s = await state();
    if (s.anim === 'Jump') {
      jumped = true;
      if (!shot) {
        await follow();
        await page.waitForTimeout(60);
        await page.screenshot({ path: join(out, `sim-${shotName}-jump.png`) });
        shot = true;
      }
    }
    if (!s.goal && i > 1) break;
  }
  await page.waitForTimeout(400);
  s = await state();
  await follow();
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(out, `sim-${shotName}.png`) });
  const d = Math.hypot(s.pos[0] - point[0], s.pos[2] - point[2]);
  check(Math.abs(s.pos[1] - expectY) < 0.03 && d < 0.25 && s.anim === 'Wave', `${name}: arrives (y=${s.pos[1].toFixed(2)}, ${d.toFixed(2)} m from the tap, ${s.anim})${jumped ? ', jumping on the way' : ''}`);
  return jumped;
}

check(await callTo('stool', [0.95, 0.46, 0.05], 0.46, '2-stool'), 'stool trip includes a jump');
check(await callTo('floor', [-0.7, 0, 0.9], 0, '3-floor'), 'floor trip includes a jump');
check(await callTo('crate', [-1.2, 0.3, 0.6], 0.3, '4-crate'), 'crate trip includes a jump');
check(await callTo('shelf', [-0.2, 1.18, -0.95], 1.18, '5-shelf'), 'shelf trip includes a jump');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll simulator checks passed');
process.exit(failures ? 1 : 0);
