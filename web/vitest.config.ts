// Unit and component tests live next to the code as `*.test.ts`.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.ts'],
      restoreMocks: true,
      unstubGlobals: true,
      // CSS is skipped in tests except the theme, whose source theme.test.ts reads with ?raw.
      css: { include: [/theme\.css/] },
    },
  }),
);
