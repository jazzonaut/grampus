// Delivery tests: recovery of no-change delivery after a controller exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Delivery } from '../src/deliveries.js';
import { windows, git, noChangeFixture, deadController, crash } from './helpers/deliveries.js';

test(
  'actual controller exit after no-change verification recovers through a new CLI without Git writes',
  windows,
  async t => {
    const f = await noChangeFixture(t);
    crash(f, false);
    const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
    assert.equal(pending.phase, 'running');
    assert.equal(pending.outcome, null);
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
    assert.ok(f.store.lease(f.workspace.id));
    // A writer would fail against this lock. Read-only receipt recovery must preserve it.
    const lockPath = git(f.workspace.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    writeFileSync(lockPath, 'fixture lock\n');
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const result = JSON.parse(
      execFileSync(process.execPath, [cli, 'delivery-recover', pending.id, '--db', f.db], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ) as Delivery;
    assert.equal(result.phase, 'delivered', JSON.stringify(result));
    assert.equal(result.outcome, 'no_change');
    assert.equal(result.commit, null);
    assert.equal(readFileSync(lockPath, 'utf8'), 'fixture lock\n');
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.equal(f.workflow.get(f.task.id).phase, 'complete');
    assert.equal(f.store.lease(f.workspace.id), null);
  },
);

test('no-change recovery refuses missing receipts, changed HEAD, index, files and instructions', windows, async t => {
  const missing = await noChangeFixture(t);
  const unknown = await missing.deliveries.run(missing.execution.id, missing.spec, undefined, async () => {
    throw new Error('Unknown dispatch');
  });
  deadController(missing);
  await assert.rejects(missing.deliveries.recover(unknown.id));
  assert.ok(missing.store.lease(missing.workspace.id));
  for (const change of [
    (f: Awaited<ReturnType<typeof noChangeFixture>>) => {
      git(f.workspace.path, 'commit', '--allow-empty', '-m', 'Unrelated commit');
    },
    (f: Awaited<ReturnType<typeof noChangeFixture>>) => {
      git(f.workspace.path, 'update-index', '--chmod=-x', 'greeting.js');
    },
    (f: Awaited<ReturnType<typeof noChangeFixture>>) => {
      writeFileSync(join(f.workspace.path, 'obsolete.txt'), 'changed\n');
    },
    (f: Awaited<ReturnType<typeof noChangeFixture>>) => {
      writeFileSync(join(f.root, 'AGENTS.md'), 'New inherited instructions\n');
    },
  ]) {
    const f = await noChangeFixture(t);
    crash(f, false);
    change(f);
    const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
    const result = await f.deliveries.recover(pending.id);
    assert.equal(result.phase, 'failed');
    assert.equal(result.outcome, null);
    assert.equal(result.commit, null);
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
    assert.equal(f.store.lease(f.workspace.id), null);
  }
});
