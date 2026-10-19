// Authenticated guidance actions mutate the controller queue without launching a worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startUi } from '../src/server/ui-server.js';
import type { TaskDetailV1 } from '../src/server/api-types.js';
import { fixture } from './helpers/guided-tasks.js';

test('dashboard guidance and cancellation use the displayed key and start no worker or provider', async t => {
  const cleanups: (() => void)[] = [];
  const f = fixture({ after: fn => cleanups.push(fn) });
  const ui = await startUi({ db: f.store.path, port: 0 });
  t.after(async () => {
    await ui.close();
    for (const cleanup of cleanups) cleanup();
  });
  const url = new URL(ui.url),
    headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const id = f.create();
  const read = async () =>
    (await (await fetch(`${url.origin}/api/v1/tasks/${id}`, { headers })).json()) as TaskDetailV1;
  const post = (path: string, body: unknown) =>
    fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const initial = await read();
  const compose = initial.guidance.compose!;
  const body = { ...compose.request.body, text: 'Use the simpler approach.', target: 'implementer' };
  assert.equal((await post(compose.request.path, { ...body, expected: 'stale' })).status, 409);
  assert.equal((await post(compose.request.path, { ...body, target: 'administrator' })).status, 400);
  const response = await post(compose.request.path, body);
  assert.equal(response.status, 200, await response.clone().text());
  const queued = await read();
  assert.equal(queued.guidance.messages[0]!.status, 'queued');
  assert.equal(queued.guidance.draftKey, initial.guidance.draftKey);
  assert.equal(queued.details.approval.digest, initial.details.approval.digest);
  assert.equal(ui.job(id), null);
  assert.deepEqual(f.store.sessions(), []);
  const cancel = queued.guidance.messages[0]!.cancel!;
  assert.equal((await post(cancel.request.path, cancel.request.body)).status, 200);
  assert.equal((await read()).guidance.messages[0]!.status, 'cancelled');
  assert.equal(ui.job(id), null);
});
