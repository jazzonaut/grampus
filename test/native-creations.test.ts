// Tool decisions identify native creations without trusting provider claims or another turn's actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeCreationPaths } from '../src/execution/native-creations.js';
import type { RepositorySnapshot } from '../src/repository/artifacts.js';

test('native creation inventory accepts both provider decisions and excludes existing files and foreign turns', () => {
  const before: RepositorySnapshot = {
    artifact: 'unchanged',
    head: 'unchanged',
    index: 'unchanged',
    instructionsDigest: 'unchanged',
    files: [{ path: 'src/existing.ts', sha256: 'existing', executable: false }],
    diff: [],
    instructions: [],
  };
  const event = (tool: string, data: object, runId = 'current') => ({
    type: 'tool.authorized',
    data: { runId, data: { tool, ...data } },
  });
  assert.deepEqual(
    nativeCreationPaths(
      [
        event('Write', { path: 'src/new.ts' }),
        event('apply_patch', { paths: ['src/new.ts', 'src/other.ts', before.files[0]!.path] }),
        event('Write', { path: 'src/foreign.ts' }, 'previous'),
        event('Read', { path: 'src/read.ts' }),
        { type: 'tool.denied', data: { runId: 'current', data: { tool: 'Write', path: 'src/denied.ts' } } },
      ],
      'current',
      before,
    ),
    ['src/new.ts', 'src/other.ts'],
  );
});
