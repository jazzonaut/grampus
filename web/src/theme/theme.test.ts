import { describe, expect, it } from 'vitest';
import { icons as lucide } from '@iconify-json/lucide';
import css from './theme.css?raw';
import { paletteColors } from './tokens';
import { stagePresentation, statusPresentation } from './status';

describe('theme', () => {
  it('declares every Nuxt UI colour variable from the palette in tokens.ts', () => {
    for (const [semantic, palette] of Object.entries(paletteColors)) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950])
        expect(css).toContain(`--ui-color-${semantic}-${shade}: var(--color-${palette}-${shade});`);
      if (semantic !== 'neutral') expect(css).toMatch(new RegExp(`--ui-${semantic}: var\\(--ui-color-${semantic}-`));
    }
  });

  it('uses only icons that exist in the bundled Lucide collection', () => {
    const names = [...Object.values(statusPresentation), ...Object.values(stagePresentation)].map(look =>
      look.icon.replace(/^i-lucide-/, ''),
    );
    for (const name of names) expect(lucide.icons[name] ?? lucide.aliases?.[name], name).toBeDefined();
  });
});
