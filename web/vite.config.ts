// Build for the Grampus dashboard client. The output in dist/ is served by the local Grampus
// server under a strict CSP (script-src 'self'; style-src 'self'; connect-src 'self';
// img-src 'self' data:), so everything is bundled: no remote fonts, icons or scripts.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import { paletteColors, themeColors } from './src/theme/tokens.ts';

// A running Grampus dashboard (`npm run ui` uses port 4318) answers /api in development.
const apiTarget = process.env['GRAMPUS_API'] ?? 'http://127.0.0.1:4318';

export default defineConfig({
  // Relative URLs so the server can mount dist/ at any path without rewriting index.html.
  base: './',
  plugins: [
    vue(),
    // Nuxt UI brings Tailwind's Vite plugin. Components are imported explicitly, so the
    // auto-import plugins are off.
    ui({
      components: false,
      autoImport: false,
      // No vue-router: the access token lives in the URL fragment, so hash routing is unavailable.
      router: false,
      // src/theme/colorScheme.ts follows prefers-color-scheme; nothing is stored.
      colorMode: false,
      theme: { colors: themeColors },
      ui: { colors: { ...paletteColors } },
      icon: {
        // Bundle every icon so none is fetched from the Iconify API (CSP blocks it anyway).
        // The scan finds literal `i-lucide-*` names in src, including .ts files.
        clientBundle: {
          scan: {
            globInclude: ['src/**/*.{vue,ts}'],
            globExclude: ['**/*.test.ts', 'node_modules', 'dist'],
          },
        },
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    // Never inline assets as data: URLs; the CSP has no font-src, so an inlined font would be blocked.
    assetsInlineLimit: 0,
    // Modern browsers support modulepreload; skipping the polyfill keeps the entry smaller.
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // The Grampus server rejects a foreign Origin, so present the server's own.
        configure: proxy => {
          proxy.on('proxyReq', request => {
            if (request.getHeader('origin') !== undefined) request.setHeader('origin', apiTarget);
          });
        },
      },
    },
  },
});
