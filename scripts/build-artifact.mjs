// Packs the production build (dist/) into one self-contained HTML body for publishing as a
// claude.ai artifact: CSS and JS are inlined, the document skeleton is stripped (the host adds it).
//
//   npm run build && node scripts/build-artifact.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const dist = 'dist';
const html = await readFile(join(dist, 'index.html'), 'utf8');

const scriptSrc = html.match(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/)?.[1];
const cssHref = html.match(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/)?.[1];
if (!scriptSrc || !cssHref) throw new Error('Unexpected dist/index.html layout');
const jsSource = (await readFile(join(dist, scriptSrc), 'utf8')).replace(/<\/script/gi, '<\\/script');
const css = await readFile(join(dist, cssHref), 'utf8');

// Embed the companion model so the page needs no extra files.
const model = (await readFile(join(dist, 'models/RobotExpressive.glb'))).toString('base64');
const modelRef = /(["'`])\.\/models\/RobotExpressive\.glb\1/g;
if (!modelRef.test(jsSource)) throw new Error('Model URL not found in the bundle');
const js = jsSource.replace(modelRef, `"data:model/gltf-binary;base64,${model}"`);

const title = html.match(/<title>.*?<\/title>/)[0];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script[^>]*src=[^>]*><\/script>/g, '').trim();

const out = `${title}
<style>${css}</style>
${body}
<script type="module">${js}</script>
`;
await mkdir('dist-artifact', { recursive: true });
await writeFile('dist-artifact/tripoint-ar.html', out);
console.log(`dist-artifact/tripoint-ar.html (${(out.length / 1024).toFixed(0)} KB)`);
