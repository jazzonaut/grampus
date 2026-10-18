// Delivery tests: recovery after lost replies, controller exits and changed commits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Executions } from '../src/executions.js';
import { type Delivery } from '../src/deliveries.js';
import { runCheckProcess } from '../src/check-process.js';
import { windows, git, fixture, deadController, crash } from './helpers/deliveries.js';

test(
  'settled delivery with a lost reply requires explicit recovery and cannot use read-only recovery',
  windows,
  async t => {
    const f = await fixture(t);
    const result = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
      await runCheckProcess(options);
      throw new Error('Lost reply');
    });
    assert.equal(result.phase, 'recovery_required');
    assert.ok(f.store.lease(f.workspace.id));
    assert.throws(() => new Executions(f.store).recoverReadOnly(f.execution.id), /No recoverable read-only/);
    await assert.rejects(f.deliveries.recover(result.id), /controller is still alive/);
    deadController(f);
    const recovered = await f.deliveries.recover(result.id);
    assert.equal(recovered.phase, 'delivered', recovered.error ?? undefined);
    assert.equal(f.workflow.get(f.task.id).phase, 'complete');
    assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '2');
  },
);

test('absent processes without a matching delivery receipt cannot release ownership', windows, async t => {
  const f = await fixture(t);
  const result = await f.deliveries.run(f.execution.id, f.spec, undefined, async () => {
    throw new Error('Unknown dispatch');
  });
  deadController(f);
  await assert.rejects(f.deliveries.recover(result.id));
  assert.ok(f.store.lease(f.workspace.id));
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
});

test('actual controller exit after Git commit is recovered by CLI without replay', windows, async t => {
  const f = await fixture(t);
  crash(f, false);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  assert.equal(pending.phase, 'running');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = JSON.parse(
    execFileSync(process.execPath, [cli, 'delivery-recover', pending.id, '--db', f.db], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  ) as Delivery;
  assert.equal(result.phase, 'delivered', result.error ?? undefined);
  assert.equal(f.workflow.get(f.task.id).phase, 'complete');
  assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '2');
});

test('pre-dispatch crash recovery releases only the proven unused delivery and never commits', windows, async t => {
  const f = await fixture(t);
  crash(f, true);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  const result = await f.deliveries.recover(pending.id);
  assert.equal(result.phase, 'interrupted');
  assert.equal(result.dispatch, 'not_requested');
  assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('recovery refuses a changed commit or working tree despite a successful settlement receipt', windows, async t => {
  const f = await fixture(t);
  crash(f, false);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  writeFileSync(join(f.workspace.path, 'greeting.js'), 'changed after commit\n');
  const recovered = await f.deliveries.recover(pending.id);
  assert.equal(recovered.phase, 'failed');
  assert.match(recovered.error!, /Working files/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('delivery recovery rejects a replaced commit even when its tree matches', windows, async t => {
  const f = await fixture(t);
  crash(f, false);
  const pending = f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
  git(f.workspace.path, 'commit', '--amend', '-m', 'Unrelated replacement commit');
  const result = await f.deliveries.recover(pending.id);
  assert.equal(result.phase, 'failed');
  assert.match(result.error!, /message or operation marker/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
});
