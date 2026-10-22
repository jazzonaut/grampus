// Builds the dashboard into dist/web, which `grampus dashboard` serves. `npm run dev:web` serves it with
// hot reload and forwards /api to a running `grampus dashboard`.
import ui from '@nuxt/ui/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  root: import.meta.dirname,
  plugins: [
    vue(),
    ui({
      // The component and auto-import type files are written in dev only: concurrent writes during a build
      // can hit a file lock on Windows. They only refine template types, so a stale copy is harmless.
      dts: command === 'serve',
      ui: { colors: { primary: 'ocean', neutral: 'slate' } },
      // Bundle every icon the app names, so the dashboard never fetches icons from the internet.
      icon: { clientBundle: { scan: { globInclude: ['app/**/*.{vue,ts}'], globExclude: ['node_modules', 'dist'] } } },
    }),
  ],
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/api': 'http://localhost:4545' } },
}));
