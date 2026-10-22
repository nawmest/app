// End-to-end test: serves the production build and opens it in Chromium with a synthetic front
// camera (e2e/fake-front-camera.js) filming a rendered head whose skin pulses at a known rate.
// Checks guidance, the scan flow, live vitals and the final heart rate against ground truth.
//
//   npm run build && npm run e2e            (BPM=90 npm run e2e to change the simulated rate)
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const BPM = Number(process.env.BPM ?? 78);
const out = resolve('test-output');
await mkdir(out, { recursive: true });
const server = await serve();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
// 1x pixel density keeps this slow, software-rendered browser above the app's minimum frame rate.
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const head = await readFile(resolve('e2e/fixtures/head.png'));
await page.route('**/e2e/fixtures/head.png', (r) => r.fulfill({ contentType: 'image/png', body: head }));
await page.addInitScript((bpm) => (window.__fakeCamConfig = { bpm }), BPM);
await page.addInitScript({ path: resolve('e2e/fake-front-camera.js') });
// The software GPU in headless Chromium is very slow; use MediaPipe's CPU path here.
await page.goto(`${server.url}?delegate=cpu`);

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const state = () => page.evaluate(() => window.__pulse.state);
const waitFor = (fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout, polling: 250 }).then(() => true, () => false);

await page.screenshot({ path: join(out, '0-intro.png') });

// Nobody in front of the camera: the app asks for a face and doesn't start measuring.
await page.evaluate(() => (window.__fakeCam.state.present = false));
await page.click('#btn-start');
check(await waitFor(() => window.__pulse.state?.guidance === 'no-face', null, 60000), 'asks for a face when nobody is in view');
await page.waitForTimeout(800);
check((await state()).phase !== 'scanning', 'does not measure without a face');
await page.screenshot({ path: join(out, '1-no-face.png') });

// Face appears: alignment, then the scan.
await page.evaluate(() => (window.__fakeCam.state.present = true));
check(await waitFor(() => window.__pulse.state?.phase === 'scanning', null, 30000), 'starts scanning once the face is aligned');
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, '2-scan-start.png') });
check(await waitFor(() => (window.__pulse.state?.hr ?? 0) > 0, null, 40000), 'shows a live heart rate');
await page.waitForTimeout(3000);
await page.screenshot({ path: join(out, '3-scanning.png') });
check(await page.evaluate(() => document.querySelector('#card-hr').classList.contains('show')), 'metric cards float beside the face');
await waitFor(() => (window.__pulse.state?.progress ?? 0) > 0.75, null, 90000);
console.log(`      analysed frame rate: ${(await state()).fps.toFixed(1)} fps; camera drew ${await page.evaluate(() => (window.__fakeCam.state.draws / window.__fakeCam.state.t).toFixed(1))} fps`);
await page.screenshot({ path: join(out, '4-scanning-late.png') });

check(await waitFor(() => window.__pulse.state?.phase === 'done', null, 90000), 'scan completes');
const r = (await state()).result;
check(!!r && Math.abs(r.heartRate - BPM) <= 5, `final heart rate ${r ? r.heartRate.toFixed(1) : 'n/a'} bpm vs ${BPM} bpm simulated (±5)`);
check(!!r && r.quality > 0.3, `signal quality ${r ? Math.round(r.quality * 100) : 0}%`);
await page.waitForTimeout(600);
const shown = await page.textContent('#results .big .num');
check(!(await page.isHidden('#results')) && shown === String(Math.round(r.heartRate)), `results screen shows ${shown} bpm`);
await page.screenshot({ path: join(out, '5-results.png'), fullPage: true });
console.log(`      breathing: ${r?.respiration ? r.respiration.toFixed(1) + '/min (simulated 15)' : 'not reported'}; HRV: ${r?.hrv ? r.hrv.rmssd.toFixed(0) + ' ms' : 'withheld'}`);

// Wellness insights: three tiles, each opening a details sheet; age adds training zones.
const tiles = await page.$$eval('#results .tile', (els) => els.map((e) => `${e.querySelector('.tile-top').textContent.trim()}: ${e.querySelector('.tile-value').textContent.trim()}`));
check(tiles.length === 3, `wellness tiles: ${tiles.join(' · ')}`);
await page.click('#results .tile.sport');
check(await page.isVisible('#sheet[open]'), 'tapping a tile opens its details');
await page.fill('#age', '30');
await page.$eval('#age', (e) => e.blur());
check((await page.$$('#sheet .zones li')).length === 5, 'entering an age shows heart-rate zones');
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, '6-sport-sheet.png') });
await page.click('#sheet .sheet-close');
check(!(await page.isVisible('#sheet[open]')), 'the details sheet closes');
await page.click('#results .tile.stress');
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, '7-stress-sheet.png') });
await page.click('#sheet .sheet-close');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
