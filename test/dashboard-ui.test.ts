// Render dashboard prose through Vue so short Markdown stays readable without disclosure controls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { createServer } from 'vite';
import { createSSRApp, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

test('short multi-paragraph notes show their complete content without Read more', async () => {
  const server = await createServer({
    configFile: false,
    root: resolve(import.meta.dirname, '../..'),
    plugins: [vue()],
    server: { middlewareMode: true, watch: null },
    appType: 'custom',
  });
  try {
    const module = await server.ssrLoadModule('/web/app/components/ChangeNote.vue');
    const html = await renderToString(
      createSSRApp(module['default'] as Component, { source: 'A short outcome.\n\nOne small caveat.' }),
    );
    assert.match(html, /A short outcome/);
    assert.match(html, /One small caveat/);
    assert.doesNotMatch(html, /Read more|line-clamp/);
  } finally {
    await server.close();
  }
});
