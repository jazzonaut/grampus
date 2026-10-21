// Runs compiled tests from dist/test. Usage:
//   node scripts/run-tests.mjs fast        every file except those listed in scripts/slow-tests.json
//   node scripts/run-tests.mjs all         every file
//   node scripts/run-tests.mjs <name>...   selected files, e.g. guided-tasks-staging checks-review;
//                                          a name without its own file selects every <name>-*.test.js
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..'),
  directory = join(root, 'dist', 'test');
// Each test file starts many Git processes; CPU count alone oversubscribes Windows under load.
const windowsWorkerLimit = 4;
const workers = Math.max(2, availableParallelism() - 1);
const concurrency = process.platform === 'win32' ? Math.min(windowsWorkerLimit, workers) : workers;
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
      : [mode, ...rest].flatMap(name => {
          const base = name.replace(/\.test(\.(js|ts))?$/, '');
          if (files.includes(`${base}.test.js`)) return [`${base}.test.js`];
          // A split area such as guided-tasks runs every guided-tasks-*.test.js file.
          const area = files.filter(file => file.startsWith(`${base}-`));
          if (!area.length) throw new Error(`Unknown test file: ${name}`);
          return area;
        });
// A driver test that never settles would otherwise hold the run open forever; force-exit ends a file
// whose failed test left a driver loop running.
const testTimeoutMs = 60_000;
const result = spawnSync(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${concurrency}`,
    `--test-timeout=${testTimeoutMs}`,
    '--test-force-exit',
    ...names.map(name => join(directory, name)),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
