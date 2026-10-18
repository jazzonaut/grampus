import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Grampus requires Node.js 24 or later on PATH.');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const current = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
  if (current.schema !== 1 || typeof current.release !== 'string' || !/^[a-zA-Z0-9-]+$/.test(current.release))
    throw new Error('Invalid Grampus installation selection; rerun the installer.');
  // Resolve once. Workers and assets remain bound to this version during an update.
  await import(pathToFileURL(join(root, 'versions', current.release, 'dist', 'src', 'cli.js')).href);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
