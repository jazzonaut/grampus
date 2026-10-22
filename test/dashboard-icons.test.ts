// Every icon the dashboard names must exist in the bundled Lucide set: a misspelt name renders as a blank.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const app = join(import.meta.dirname, '..', '..', 'web', 'app');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.(vue|ts)$/.test(entry.name)
        ? [readFileSync(join(dir, entry.name), 'utf8')]
        : [],
  );
}

test('every Lucide icon the dashboard uses exists', () => {
  const lucide = createRequire(import.meta.url)('@iconify-json/lucide/icons.json') as {
    icons: Record<string, unknown>;
    aliases?: Record<string, unknown>;
  };
  const used = new Set(
    sources(app).flatMap(text => [...text.matchAll(/i-lucide-([a-z0-9-]+)/g)].map(match => match[1] ?? '')),
  );
  assert.ok(used.size > 10, 'the scan found the icons');
  const missing = [...used].filter(name => !(name in lucide.icons) && !(name in (lucide.aliases ?? {})));
  assert.deepEqual(missing, []);
});
