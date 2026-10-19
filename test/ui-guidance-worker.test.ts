// Guidance can be changed while a dashboard worker owns a real supervised validation step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { startUi } from '../src/server/ui-server.js';
import { connect, offered, settled } from './helpers/dashboard.js';
import { fixture, windows } from './helpers/guided-tasks.js';

test('queue and cancellation keep the active dashboard worker and its check unchanged', windows, async t => {
  const cleanups: (() => void)[] = [];
  const f = fixture({ after: fn => cleanups.push(fn) });
  const ui = await startUi({ db: f.store.path, port: 0 });
  const tasks = new GuidedTasks(ui.store);
  const task = tasks.create({
    ...f.plan,
    slices: [
      {
        ...f.plan.slices[0],
        mode: 'no_change',
        scope: { files: [] },
        validation: { file: 'node', args: ['-e', 'setTimeout(() => {}, 8000)'], timeoutMs: 20000 },
        acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello\n' },
      },
    ],
  });
  const id = task.id;
  t.after(async () => {
    if (ui.job(id)?.running) {
      tasks.stop(id);
      await settled(ui, id);
    }
    await ui.close();
    for (const cleanup of cleanups) cleanup();
  });
  tasks.approve(id, 1, task.guided!.digest);
  await tasks.run(id);
  const api = connect(ui);
  const authorization = await api.act(offered(await api.task(id), 'authorize'));
  assert.equal(authorization.status, 202, await authorization.clone().text());
  const deadline = Date.now() + 15000;
  const activeCheck = () => ui.store.checks(tasks.get(id).executionId!).find(check => check.toolPid);
  while (!activeCheck() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const check = activeCheck();
  assert.ok(check, 'A real check is running');
  const job = ui.job(id);
  assert.ok(job?.running);
  const view = await api.task(id);
  assert.equal(view.guidance.compose!.enabled, true);
  const queued = await api.act(view.guidance.compose!, {
    text: 'Inspect the next review carefully.',
    target: 'reviewer',
  });
  assert.equal(queued.status, 200, await queued.clone().text());
  const message = (await api.task(id)).guidance.messages[0]!;
  assert.equal(message.status, 'queued');
  const cancelled = await api.act(message.cancel!);
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal(ui.job(id), job, 'No replacement worker was started');
  assert.equal(activeCheck()!.id, check.id);
  assert.equal(activeCheck()!.toolPid, check.toolPid);
  assert.equal((await api.task(id)).guidance.messages[0]!.status, 'cancelled');
  await settled(ui, id);
  assert.equal(tasks.get(id).status, 'awaiting_assessment');
  assert.equal(ui.store.checks(tasks.get(id).executionId!).length, 1);
  assert.deepEqual(
    ui.store
      .sessions()
      .flatMap(session => ui.store.sessionEvents(session.id).filter(event => event.type === 'turn.requested')),
    [],
  );
});
