// Runs the real controller against the dashboard while an implementation is still active.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { startUi } from '../src/server/ui-server.js';
import type { LiveChangesV1, TaskDetailV1 } from '../src/server/api-types.js';
import { fixture, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test('dashboard observes live edits and accepts a bound pause while the controller is running', windows, async t => {
  const cleanups: (() => void)[] = [];
  const f = fixture({ after: fn => cleanups.push(fn) });
  const ui = await startUi({ db: f.store.path, port: 0 });
  t.after(async () => {
    await ui.close();
    for (const cleanup of cleanups) cleanup();
  });
  const url = new URL(ui.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const get = (path: string) => fetch(url.origin + path, { headers });
  const config = services();
  config.implementationRunner = async options => {
    const result = await inlineImplementation(options, "console.log('hello world');\n");
    const current = await get(`/api/v1/tasks/${id}`);
    const view = (await current.json()) as TaskDetailV1;
    assert.ok(view.liveChangesPath);
    const revision = f.store.revision();
    const liveResponse = await get(`${view.liveChangesPath}?path=greeting.js`);
    assert.equal(liveResponse.status, 200, await liveResponse.clone().text());
    const live = (await liveResponse.json()) as LiveChangesV1;
    assert.match(live.selected!.patch, /\+console.log\('hello world'\)/);
    assert.equal(f.store.revision(), revision, 'monitoring never journals evidence');
    const retained = await get(`${view.details.changesPath}?path=greeting.js`);
    assert.equal(retained.status, 404, 'the active turn has not settled a snapshot yet');
    const pause = view.decisions.find(action => action.id === 'pause')!;
    assert.equal(pause.enabled, true);
    assert.equal(
      (
        await fetch(url.origin + pause.request.path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expected: 'stale' }),
        })
      ).status,
      409,
    );
    const response = await fetch(url.origin + pause.request.path, {
      method: 'POST',
      headers,
      body: JSON.stringify(pause.request.body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const pausing = (await (await get(`/api/v1/tasks/${id}`)).json()) as TaskDetailV1;
    assert.match(pausing.header.nextStep.label, /then Grampus pauses/);
    assert.equal(pausing.decisions.find(action => action.id === 'pause')!.enabled, false);
    return result;
  };
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create(f.plan),
    id = task.id;
  tasks.approve(id, 1, task.guided!.digest);
  await tasks.run(id);
  const paused = await tasks.authorize(id);
  assert.equal(paused.stopReason?.code, 'USER_PAUSED', paused.note);
  const view = (await (await get(`/api/v1/tasks/${id}`)).json()) as TaskDetailV1;
  assert.equal(view.header.statusLabel, 'Paused');
  assert.equal(view.header.status, 'awaiting_human');
  assert.ok(view.decisions.some(action => action.id === 'run'));
  assert.ok(!view.decisions.some(action => action.id === 'retry'));
});
