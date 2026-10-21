// Restore reuse is proved from actual SQLite records and bytes, including ignored managed outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, windows } from './helpers/checks.js';
import { restoreFingerprint, reusableRestore } from '../src/verification/restore-reuse.js';

test(
  'unchanged prerequisite restoration is adopted, but changed inputs or managed outputs disable reuse',
  windows,
  async t => {
    const f = await fixture(t),
      cwd = f.workspaces.path(f.workspace.id);
    mkdirSync(join(cwd, 'generated'));
    writeFileSync(join(cwd, 'generated', 'installed'), 'v1');
    const spec = { ...(await f.spec()), preparation: {}, restore: { inputs: ['greeting.js'], outputs: ['generated'] } };
    let calls = 0;
    const runner = async () => {
      calls++;
      return {
        reason: 'exited' as const,
        exitCode: 0,
        exitConfirmed: true,
        stdout: '',
        stderr: '',
        outputTruncated: false,
      };
    };
    const first = await f.checks.run(f.execution.id, spec, undefined, runner);
    const second = await f.checks.run(f.execution.id, spec, undefined, runner);
    assert.equal(first.phase, 'passed', first.error ?? '');
    assert.equal(second.phase, 'passed', second.error ?? '');
    assert.equal(second.reusedFrom, first.id);
    assert.equal(calls, 1);
    const target = { ...second, id: 'not-dispatched' };
    writeFileSync(join(cwd, 'generated', 'installed'), 'changed');
    restoreFingerprint(cwd, target, 'before');
    assert.equal(reusableRestore(f.store, f.execution, target, cwd), null);
    writeFileSync(join(cwd, 'generated', 'installed'), 'v1');
    writeFileSync(join(cwd, 'greeting.js'), 'changed source input');
    restoreFingerprint(cwd, target, 'before');
    assert.equal(reusableRestore(f.store, f.execution, target, cwd), null);
    rmSync(join(cwd, 'generated'), { recursive: true });
    assert.equal(reusableRestore(f.store, f.execution, target, cwd), null);
  },
);
