import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser talks to a single origin; /api is proxied to the Nest API so session cookies stay first-party.
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } } },
});
