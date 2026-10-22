// 3D end-to-end test: a WebGL fake camera films a poster lying on a table in true perspective
// (e2e/fake-camera-3d.js) while orbiting it. The test taps three corners of a square on the
// poster, moves the camera and measures where 3D content floating above the virtual QR code is
// drawn, compared with where it really should be.
//
//   npm run build && npm run e2e:3d
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const out = resolve('test-output');
await mkdir(out, { recursive: true });
const server = await serve();
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript({ path: resolve('e2e/fake-camera-3d.js') });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const frames = () => page.evaluate(() => window.__tripoint.frames);
const waitFrames = async (n) => {
  const f0 = await frames();
  await page.waitForFunction((target) => window.__tripoint.frames >= target, f0 + n, { timeout: 20000 });
};
const angle = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const setT = (t) => page.evaluate((t) => (window.__fakeCam.state.t = t), t);

async function scenario(name, corners, exactTaps) {
  console.log(`\n${name}`);
  await page.goto(server.url);
  await setT(0);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__tripoint.mode === 'pinning' && window.__tripoint.frames > 5);
  await waitFrames(3);

  // Tap three corners of a real square on the poster.
  for (const X of corners) {
    const pos = await page.evaluate((X) => {
      const [x, y] = window.__fakeCam.project(X);
      const v = window.__tripoint.view;
      return [v.left + (x / window.__fakeCam.width) * v.width, v.top + (y / window.__fakeCam.height) * v.height];
    }, X);
    await page.mouse.click(pos[0], pos[1]);
    await waitFrames(2);
  }
  await page.waitForFunction(() => window.__tripoint.mode === 'tracking');

  // The true 3D frame of the virtual code: the square whose corners were tapped.
  const truth = await page.evaluate((W) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const len = (a) => Math.sqrt(dot(a, a));
    const d2 = sub(W[1], W[0]);
    const e1 = d2.map((v) => v / len(d2));
    const d3 = sub(W[2], W[0]);
    const p3 = d3.map((v, i) => v - dot(d3, e1) * e1[i]);
    const e2 = p3.map((v) => v / len(p3));
    const side = 0.5 * (len(d2) + Math.abs(dot(d3, e2)));
    return { W, e1, e2, side, normal0: window.__fakeCam.normal() };
  }, corners);

  /** Error (in % of the screen width) of content at the centre of the code, at height h sides. */
  async function measure(label, heights = [0, 0.5, 1]) {
    const r = await page.evaluate(
      ({ truth, heights }) => {
        const [pw] = window.__tripoint.processingSize;
        const s = window.__fakeCam.width / pw;
        return heights.map((h) => {
          const app = window.__tripoint.project(0.5, 0.5, h);
          if (!app) return null;
          const X = [0, 1, 2].map((i) => truth.W[0][i] + truth.side * (0.5 * truth.e1[i] + 0.5 * truth.e2[i]) - (i === 2 ? truth.side * h : 0));
          const [x, y] = window.__fakeCam.project(X);
          return (100 * Math.hypot(app[0] * s - x, app[1] * s - y)) / window.__fakeCam.width;
        });
      },
      { truth, heights },
    );
    const worst = Math.max(...r.map((v) => (v == null ? Infinity : v)));
    const plane = await page.evaluate(() => window.__tripoint.plane);
    const tilt = plane ? angle(plane.normal, truth.normal0).toFixed(1) : 'n/a';
    console.log(`      ${label}: error at height 0 / 0.5 / 1 side = ${r.map((v) => (v == null ? 'n/a' : v.toFixed(2) + '%')).join(' / ')}  (tilt error ${tilt} deg, depth confidence ${plane?.confidence.toFixed(2)})`);
    return worst;
  }

  const plane0 = await page.evaluate(() => window.__tripoint.plane);
  const tiltErr = angle(plane0.normal, truth.normal0);
  await waitFrames(3);
  const atLock = await measure('right after lock');
  if (exactTaps) {
    check(tiltErr < 3, `surface tilt from the taps alone: ${tiltErr.toFixed(1)} degrees off`);
    check(atLock < 1, 'content placed in 3D right after lock');
  } else {
    console.log(`      surface tilt from the taps alone: ${tiltErr.toFixed(1)} degrees off (taps are not a square)`);
  }
  await page.screenshot({ path: join(out, `3d-${name.split(' ')[0]}-0-lock.png`) });

  // Orbit the camera around the code in small steps (independent of the browser's frame rate).
  let worstMoving = 0;
  let t = 0;
  for (let leg = 1; leg <= 4; leg++) {
    for (let k = 0; k < 40; k++) {
      t += 0.04;
      await setT(t);
      await waitFrames(1);
    }
    await waitFrames(6); // let the smoothing settle
    worstMoving = Math.max(worstMoving, await measure(`after camera move ${leg} (t=${t.toFixed(2)})`));
    await page.screenshot({ path: join(out, `3d-${name.split(' ')[0]}-${leg}-move.png`) });
  }
  check(worstMoving < 2.5, `3D content stays within 2.5% of the screen width of its true position while orbiting (worst ${worstMoving.toFixed(2)}%)`);
  const plane1 = await page.evaluate(() => window.__tripoint.plane);
  check(plane1.confidence >= 1, `depth measured from camera motion (confidence ${plane1.confidence.toFixed(2)})`);
  const finalErr = await measure('final');
  const limit = exactTaps ? 1 : 2;
  check(finalErr < limit, `after moving around, content is within ${limit}% of the screen width (${finalErr.toFixed(2)}%)`);
}

await scenario('exact square taps', [[-0.45, -0.45, 0], [0.45, -0.45, 0], [-0.45, 0.45, 0]], true);
await scenario('imprecise taps (not a square)', [[-0.45, -0.45, 0], [0.5, -0.4, 0], [-0.38, 0.3, 0]], false);
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll 3D e2e checks passed');
process.exit(failures ? 1 : 0);
