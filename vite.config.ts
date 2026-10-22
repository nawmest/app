import { createReadStream, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Self-hosts the MediaPipe WebAssembly runtime: served from node_modules in dev and copied into
 * the build under /mediapipe, so the app makes no third-party requests.
 */
function mediapipeWasm(): Plugin {
  const dir = resolve('node_modules/@mediapipe/tasks-vision/wasm');
  const files = [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ];
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe', (req, res, next) => {
        const file = (req.url ?? '').slice(1).split('?')[0];
        if (!files.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(join(dir, file)).pipe(res);
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/${file}`, source: readFileSync(join(dir, file)) });
      }
    },
  };
}

// Camera access requires a secure context. `npm run dev` serves over HTTPS with a self-signed
// certificate so the app can be opened from a phone on the same network.
// Set NO_HTTPS=1 to serve plain HTTP (localhost counts as a secure context).
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [mediapipeWasm(), ...(command === 'serve' && !process.env.NO_HTTPS ? [basicSsl()] : [])],
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
}));
