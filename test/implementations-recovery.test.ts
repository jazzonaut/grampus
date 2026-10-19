// Implementation tests: unknown shutdown and controller death recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Executions } from '../src/execution/executions.js';
import { Sessions } from '../src/execution/sessions.js';
import { currentProcessStartedAt } from '../src/process/process-identity.js';
import { windows, git, fixture } from './helpers/implementations.js';

function crashCode(
  f: Awaited<ReturnType<typeof fixture>>,
  before: boolean,
  target = 'greeting.js',
  remove = false,
): string {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  return `import {Store} from ${url('persistence/store')}; import {Implementations} from ${url('execution/implementations')}; import {Workspaces} from ${url('repository/workspaces')};
    import {runCheckProcess} from ${url('process/check-process')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    ${before ? 'workspaces.inspect = async () => process.exit(0);' : ''}
    await new Implementations(store, workspaces).run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(f.policy)}, undefined, {},
      async options => runCheckProcess({...options,args:['-e',${JSON.stringify(`require('node:fs').${remove ? `unlinkSync(${JSON.stringify(target)})` : `writeFileSync(${JSON.stringify(target)},"console.log('partial');\\n")`};setTimeout(()=>{},30000)`)}]}));`;
}

test('unknown native shutdown retains ownership and cannot use PID-only conversation recovery', windows, async t => {
  const f = await fixture(t);
  const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async () => {
    throw new Error('Lost supervisor');
  });
  assert.equal(run.phase, 'recovery_required');
  assert.equal(f.workflow.get(f.task.id).phase, 'recovery_required');
  assert.throws(() => new Sessions(f.store).recover(f.execution.sessionId, () => false), /implementation-recover/);
  assert.throws(() => new Executions(f.store).recoverReadOnly(f.execution.id), /No recoverable read-only/);
  await assert.rejects(f.implementations.recover(run.id), /controller is still alive/);
  assert.ok(f.store.lease(f.workspace.id));
});

for (const target of ['greeting.js', 'new.txt', 'other.txt'])
  test(
    `actual controller death preserves partial ${target} change through receipt recovery without replay`,
    windows,
    async t => {
      const f = await fixture(t);
      const removal = target === 'other.txt';
      if (target === 'new.txt') f.policy.create = [target];
      if (removal) f.policy.delete = [target];
      const controller = execFile(
        process.execPath,
        ['--input-type=module', '-e', crashCode(f, false, target, removal)],
        { windowsHide: true },
      );
      controller.stdin?.end();
      const closed = new Promise<void>(resolve => controller.once('close', () => resolve()));
      t.after(() => {
        try {
          controller.kill();
        } catch {
          // The controller has usually exited already; the test only needs it gone.
        }
      });
      const waitFor = async (condition: () => boolean) => {
        const deadline = Date.now() + 15000;
        while (!condition()) {
          if (Date.now() > deadline) throw new Error('Fixture wait timed out');
          await delay(50);
        }
      };
      await waitFor(() =>
        removal
          ? !existsSync(join(f.workspace.path, target))
          : existsSync(join(f.workspace.path, target)) &&
            readFileSync(join(f.workspace.path, target), 'utf8').includes('partial'),
      );
      controller.kill();
      await closed;
      const run = f.store.implementations(f.execution.id).at(-1)!;
      await waitFor(() => existsSync(join(run.receipt!.directory, 'completion.json')));
      await waitFor(() => {
        try {
          process.kill(run.supervisorPid!, 0);
          return false;
        } catch {
          return true;
        }
      });
      const recovered = await f.implementations.recover(run.id);
      assert.equal(recovered.phase, 'interrupted');
      assert.equal(f.workflow.get(f.task.id).phase, 'stopped');
      if (removal) assert.equal(existsSync(join(f.workspace.path, target)), false);
      else assert.match(readFileSync(join(f.workspace.path, target), 'utf8'), /partial/);
      assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
      assert.equal(f.store.implementations(f.execution.id).length, 1);
      assert.equal(f.store.lease(f.workspace.id), null);
      await assert.rejects(f.implementations.run(f.execution.id, f.policy), /settled/);
    },
  );

test('native recovery before dispatch invokes no tools and marks the attempt stopped', windows, async t => {
  const f = await fixture(t);
  execFileSync(process.execPath, ['--input-type=module', '-e', crashCode(f, true)], {
    windowsHide: true,
    stdio: 'pipe',
  });
  const pending = f.store.implementations(f.execution.id).at(-1)!;
  assert.equal(pending.dispatch, 'not_requested');
  // The session run is taken over with this controller's full identity, so a later reconciler can tell
  // whether the recovering controller is still alive.
  const owners: unknown[] = [];
  const save = f.store.saveImplementation.bind(f.store);
  f.store.saveImplementation = (...args: Parameters<typeof save>) => {
    const run = new Sessions(f.store).get(f.execution.sessionId).run;
    owners.push(run && { pid: run.controllerPid, startedAt: run.controllerStartedAt });
    save(...args);
  };
  const recovered = await f.implementations.recover(pending.id);
  assert.deepEqual(owners[0], { pid: process.pid, startedAt: currentProcessStartedAt() });
  assert.equal(recovered.phase, 'interrupted');
  assert.equal(f.workflow.get(f.task.id).phase, 'stopped');
});
