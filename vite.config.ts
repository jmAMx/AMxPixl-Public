import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// package.json is the single source of the version (tauri.conf.json reads it too).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Relative base so the built app loads from disk inside a desktop shell (Tauri/Electron).
export default defineConfig({
  base: './',
  clearScreen: false,
  // A build number travels as semver build metadata ("0.4.5+1") and is shown as a fourth part ("0.4.5.1").
  define: { __APP_VERSION__: JSON.stringify(version.replace('+', '.')) },
  server: { port: 1420, strictPort: true },
  build: { target: 'chrome110', outDir: 'dist', sourcemap: false },
});
