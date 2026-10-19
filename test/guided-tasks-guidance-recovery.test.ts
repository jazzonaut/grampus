// Recovery restores guidance only when it proves that no leaf operation ever dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, windows } from './helpers/guided-tasks.js';

test(
  'recovery before leaf dispatch restores the frozen batch and waits for explicit continuation',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    const message = f.tasks.queueGuidance(id, 'Keep the restored implementation direct.', 'implementer').guidance[0]!;
    const script = join(f.root, 'crash-before-dispatch.mjs');
    const source = (path: string) => JSON.stringify(new URL(`../src/${path}.js`, import.meta.url).href);
    writeFileSync(
      script,
      `
    import {Store} from ${source('persistence/store')};
    import {GuidedTasks} from ${source('orchestration/guided/controller')};
    const store = new Store(${JSON.stringify(f.store.path)});
    const tasks = new GuidedTasks(store);
    tasks.perform = async () => process.exit(29);
    await tasks.authorize(${JSON.stringify(id)});
  `,
    );
    assert.throws(
      () => execFileSync(process.execPath, [script], { windowsHide: true, stdio: 'pipe' }),
      (error: unknown) => (error as { status: number }).status === 29,
    );
    const before = f.tasks.get(id);
    assert.deepEqual(before.guidance, []);
    assert.deepEqual(
      before.pending!.guidance.map(item => item.id),
      [message.id],
    );
    const recovered = await f.tasks.recover(id);
    assert.equal(recovered.status, 'ready', recovered.note);
    assert.equal(recovered.pending, null);
    assert.deepEqual(
      recovered.guidance.map(item => item.id),
      [message.id],
    );
    assert.equal(f.store.implementations(recovered.executionId!).length, 0);
    const reconciled = f.store.events(id, ['guided.step_reconciled']).at(-1)!;
    assert.deepEqual((reconciled.data as { restoredGuidance: string[] }).restoredGuidance, [message.id]);
    const done = await f.tasks.run(id);
    assert.equal(done.status, 'awaiting_assessment', done.note);
    assert.deepEqual(done.guidance, []);
    assert.equal(f.store.implementations(done.executionId!).length, 1);
  },
);
