import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.ADE_API ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // xterm.js + React rondan los 580 kB; es una app local, no merece más troceado.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    strictPort: true,
    // El proxy evita CORS: el navegador solo habla con Vite, que reenvía /api al server.
    proxy: { '/api': { target: apiTarget } },
  },
});
