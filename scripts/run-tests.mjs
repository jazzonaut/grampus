// Runs compiled tests from dist/test. Usage:
//   node scripts/run-tests.mjs fast        every file except those listed in scripts/slow-tests.json
//   node scripts/run-tests.mjs all         every file
//   node scripts/run-tests.mjs <name>...   selected files, e.g. guided-tasks checks
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..'),
  directory = join(root, 'dist', 'test');
const files = readdirSync(directory)
  .filter(name => name.endsWith('.test.js'))
  .sort();
const slow = new Set(JSON.parse(readFileSync(join(import.meta.dirname, 'slow-tests.json'), 'utf8')));
const [mode = 'fast', ...rest] = process.argv.slice(2);
const names =
  mode === 'all'
    ? files
    : mode === 'fast'
      ? files.filter(name => !slow.has(name.replace(/\.test\.js$/, '')))
      : [mode, ...rest].map(name => {
          const file = name.endsWith('.test.js') ? name : `${name.replace(/\.test(\.ts)?$/, '')}.test.js`;
          if (!files.includes(file)) throw new Error(`Unknown test file: ${name}`);
          return file;
        });
const result = spawnSync(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${Math.max(2, availableParallelism() - 1)}`,
    ...names.map(name => join(directory, name)),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
