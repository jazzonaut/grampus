// Pins the argument grammar separately from provider schemas, including option and path injection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticArguments } from '../src/domain/diagnostics.js';
import { runImplementationTool } from '../src/providers/implementation-tools.js';

test('focused diagnostics select only declared options and current repository files', async () => {
  const grammar = {
    parameters: [
      { name: 'filter', flag: '--test-name-pattern' },
      { name: 'mode', flag: '--mode', values: ['unit'] },
    ],
    fileSuffixes: ['.test.js'],
  };
  const inventory = new Set(['src/unit.test.js', 'package.json']);
  assert.deepEqual(
    diagnosticArguments(grammar, { parameters: { filter: 'a.*b' }, files: ['src/unit.test.js'] }, inventory),
    ['--test-name-pattern', 'a.*b', 'src/unit.test.js'],
  );
  for (const selection of [
    { parameters: { eval: 'run' } },
    { parameters: { mode: 'integration' } },
    { parameters: { filter: '--eval' } },
    { files: ['../escape.test.js'] },
    { files: ['package.json'] },
    { files: ['absent.test.js'] },
  ])
    assert.throws(() => diagnosticArguments(grammar, selection, inventory));
  let received: unknown;
  await runImplementationTool(
    {
      run: async (name, selection) => {
        received = { name, selection };
      },
    },
    { name: 'diagnostic:tests', files: ['src/unit.test.js'] },
  );
  assert.deepEqual(received, { name: 'diagnostic:tests', selection: { files: ['src/unit.test.js'] } });
});
