import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';
const server = await serve();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const head = await readFile(resolve('e2e/fixtures/head.png'));
await page.route('**/e2e/fixtures/head.png', (r) => r.fulfill({ contentType: 'image/png', body: head }));
await page.addInitScript({ path: resolve('e2e/fake-front-camera.js') });
await page.goto(`${server.url}?delegate=cpu`);
await page.click('#btn-start');
await page.waitForTimeout(15000);
for (let i = 0; i < 6; i++) { await page.waitForTimeout(3000); console.log(await page.evaluate(() => { const s = window.__pulse.state; return { fps: s.fps.toFixed(1), tier: s.perfTier, phase: s.phase }; })); }
await browser.close(); server.close();
