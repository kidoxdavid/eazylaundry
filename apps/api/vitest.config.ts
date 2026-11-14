import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // cast: the workspace has two Vite majors (web uses 6, vitest uses 7), so plugin types differ
  plugins: [swc.vite({ module: { type: 'es6' } }) as any],
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
