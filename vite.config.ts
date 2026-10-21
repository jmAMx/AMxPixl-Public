import { defineConfig } from 'vite';

// Relative base so the built app loads from disk inside a desktop shell (Tauri/Electron).
export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'chrome110', outDir: 'dist', sourcemap: false },
});
