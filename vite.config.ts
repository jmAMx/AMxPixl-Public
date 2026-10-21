import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// package.json is the single source of the version (tauri.conf.json reads it too).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Relative base so the built app loads from disk inside a desktop shell (Tauri/Electron).
export default defineConfig({
  base: './',
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 1420, strictPort: true },
  build: { target: 'chrome110', outDir: 'dist', sourcemap: false },
});
