// Phase observations include failed operations without becoming implementation or check evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePhase, measureSyncPhase } from '../src/execution/phase-timing.js';
import { executionPhases } from '../src/reporting/execution-phases.js';
import { fixture, windows } from './helpers/checks.js';

test(
  'execution phase measurements retain failures and aggregate without inventing missing phases',
  windows,
  async t => {
    const f = await fixture(t);
    assert.equal(await measurePhase(f.store, f.execution.id, 'command', async () => 42), 42);
    await assert.rejects(
      measurePhase(f.store, f.execution.id, 'command', async () => {
        throw new Error('Failed command');
      }),
      /Failed command/,
    );
    assert.throws(
      () =>
        measureSyncPhase(f.store, f.execution.id, 'input_fingerprint', () => {
          throw new Error('Missing input');
        }),
      /Missing input/,
    );
    const rows = executionPhases(f.store, f.task.id);
    assert.equal(rows.find(row => row.phase === 'command')?.observations, 2);
    assert.equal(rows.find(row => row.phase === 'command')?.failed, 1);
    assert.equal(rows.find(row => row.phase === 'input_fingerprint')?.failed, 1);
    assert.equal(
      rows.find(row => row.phase === 'provider_startup'),
      undefined,
    );
    assert.ok(rows.every(row => row.elapsedMs >= 0));
    assert.deepEqual(f.store.checks(f.execution.id), []);
  },
);
