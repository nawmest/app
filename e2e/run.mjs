// End-to-end test: serves the production build, opens it in Chromium with a synthetic camera
// (e2e/fake-camera.js), pins three points by tapping, moves the "camera" and checks that the
// tracked virtual QR code stays on the pinned spots. Also checks lost/relocalize behaviour.
//
//   npm run build && npm run e2e
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('dist');
const out = resolve('test-output');
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path.endsWith('/')) path = join(path, 'index.html');
  try {
    const file = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript({ path: resolve('e2e/fake-camera.js') });
await page.goto(url);

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const app = (expr) => page.evaluate(expr);
const sleep = (ms) => page.waitForTimeout(ms);

await page.screenshot({ path: join(out, '0-intro.png') });
await page.click('#btn-start');
await page.waitForFunction(() => window.__tripoint.mode === 'pinning' && window.__tripoint.frames > 10);
check(true, 'camera started and frames are processed');

// Freeze the scene while pinning so ground truth is exact.
await app(() => (window.__fakeCam.state.frozen = true));
await sleep(300);

const texPoints = [[250, 250], [550, 250], [250, 550]];
for (const [u, v] of texPoints) {
  const pos = await page.evaluate(([u, v]) => {
    const [x, y] = window.__fakeCam.project(u, v);
    const view = window.__tripoint.view;
    return [view.left + (x / window.__fakeCam.width) * view.width, view.top + (y / window.__fakeCam.height) * view.height];
  }, [u, v]);
  await page.mouse.click(pos[0], pos[1]);
  await sleep(250);
  if (texPoints.indexOf(texPoints.find((p) => p[0] === u && p[1] === v)) === 1) {
    await page.screenshot({ path: join(out, '1-pinning.png') });
  }
}
await page.waitForFunction(() => window.__tripoint.mode === 'tracking');
check(true, 'three pins placed, tracking started');

// Where the (snapped) pins really are on the poster.
const pinTex = await page.evaluate(() => {
  const [pw] = window.__tripoint.processingSize;
  const s = window.__fakeCam.width / pw;
  const p = window.__tripoint.pins;
  return [0, 1, 2].map((k) => window.__fakeCam.unproject(p[2 * k] * s, p[2 * k + 1] * s));
});

async function measure(label) {
  await app(() => (window.__fakeCam.state.frozen = true));
  await sleep(900); // let the smoothing filter settle
  const r = await page.evaluate((pinTex) => {
    const t = window.__tripoint;
    const [pw] = t.processingSize;
    const s = pw / window.__fakeCam.width;
    if (!t.quad) return { state: t.trackerState, err: Infinity };
    const corners = [0, 1, 3].map((i) => [t.quad[2 * i], t.quad[2 * i + 1]]);
    let err = 0;
    pinTex.forEach(([u, v], k) => {
      const [x, y] = window.__fakeCam.project(u, v);
      err = Math.max(err, Math.hypot(corners[k][0] - x * s, corners[k][1] - y * s));
    });
    return { state: t.trackerState, err };
  }, pinTex);
  check(r.state === 'tracking' && r.err < 3, `${label}: state=${r.state}, max pin error=${r.err.toFixed(2)} px (processing res)`);
  return r;
}

await measure('right after lock');
await page.screenshot({ path: join(out, '2-locked.png') });

for (const [i, anim] of ['hologram', 'qrwave', 'fountain', 'solar', 'fireworks'].entries()) {
  await page.click(`.chip[data-id="${anim}"]`);
  await app(() => (window.__fakeCam.state.frozen = false));
  await sleep(1500);
  await page.screenshot({ path: join(out, `3-${i}-${anim}.png`) });
  await measure(`after moving with "${anim}"`);
}

// Look away (a different, static scene), then come back to about where the target was lost.
await app(() => {
  window.__fakeCam.state.frozen = true;
  window.__fakeCam.state.away = true;
});
await page.waitForFunction(() => window.__tripoint.trackerState === 'lost', null, { timeout: 5000 }).catch(() => {});
check((await app(() => window.__tripoint.trackerState)) === 'lost', 'target reported lost when the camera looks away');
await page.screenshot({ path: join(out, '4-lost.png') });
await app(() => {
  window.__fakeCam.state.frozen = true;
  window.__fakeCam.state.away = false;
});
await page.waitForFunction(() => window.__tripoint.trackerState === 'tracking', null, { timeout: 5000 }).catch(() => {});
await measure('after relocalization');
await page.screenshot({ path: join(out, '5-relocalized.png') });

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
