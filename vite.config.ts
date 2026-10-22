import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Camera access requires a secure context. `npm run dev` serves over HTTPS with a
// self-signed certificate so the app can be opened from a phone on the same network.
// Set NO_HTTPS=1 to serve plain HTTP (localhost counts as a secure context).
export default defineConfig(({ command }) => ({
  base: './',
  plugins: command === 'serve' && !process.env.NO_HTTPS ? [basicSsl()] : [],
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
}));
