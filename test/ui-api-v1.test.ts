// Dashboard API v1 contract: bearer and origin guards with the typed error envelope, 404 for unknown
// routes and records, response shapes without inventories or raw output, timeline paging, and an
// ActionView request posted unchanged to the existing action route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startUi } from '../src/server/ui-server.js';
import type { ErrorV1, OverviewV1, TaskDetailV1, TimelinePageV1 } from '../src/server/api-types.js';
import { fixture } from './helpers/guided-tasks.js';

async function dashboard(t: { after(fn: () => void | Promise<void>): void }) {
  // The dashboard closes its journal before the fixture removes the folder.
  const cleanups: (() => void)[] = [];
  const f = fixture({ after: fn => cleanups.push(fn) });
  const ui = await startUi({ db: f.store.path, port: 0 });
  t.after(async () => {
    await ui.close();
    for (const cleanup of cleanups) cleanup();
  });
  const url = new URL(ui.url);
  const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
  return {
    f,
    origin: url.origin,
    get: (path: string, headers: Record<string, string> = auth) => fetch(url.origin + path, { headers }),
    post: (path: string, body: unknown) =>
      fetch(url.origin + path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

async function failure(response: Response, status: number, code: ErrorV1['error']['code']): Promise<ErrorV1> {
  assert.equal(response.status, status);
  const body = (await response.json()) as ErrorV1;
  assert.equal(body.error.status, status);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  return body;
}

test('v1 routes need the token and the local origin, and answer errors with the typed envelope', async t => {
  const api = await dashboard(t);
  await failure(await api.get('/api/v1/overview', {}), 401, 'unauthorized');
  await failure(await api.get('/api/v1/overview', { Authorization: 'Bearer wrong' }), 401, 'unauthorized');
  await failure(
    await fetch(`${api.origin}/api/v1/overview`, { headers: { Origin: 'http://evil.invalid' } }),
    403,
    'forbidden_origin',
  );
  await failure(await api.get('/api/v1/nothing'), 404, 'not_found');
  await failure(await api.get(`/api/v1/tasks/${randomUUID()}`), 404, 'not_found');
  await failure(await api.get(`/api/v1/kickoffs/${randomUUID()}`), 404, 'not_found');
  await failure(await api.get(`/api/v1/kickoffs/${randomUUID()}/timeline`), 404, 'not_found');
  const legacy = await api.get('/api/nothing');
  assert.equal(legacy.status, 404);
  assert.equal(
    typeof ((await legacy.json()) as { error: unknown }).error,
    'string',
    'other routes keep their envelope',
  );
});

test('overview, task detail and timeline have the v1 shape and no inventories or raw output', async t => {
  const api = await dashboard(t);
  const task = api.f.tasks.create(api.f.plan);
  const empty = await api.get('/api/v1/overview');
  assert.equal(empty.status, 200);
  const home = (await empty.json()) as OverviewV1;
  assert.equal(home.apiVersion, 1);
  assert.equal(home.application.name, 'Grampus');
  assert.deepEqual(
    home.tasks.map(item => [item.id, item.status, item.statusLabel]),
    [[task.id, 'awaiting_human', 'Plan ready for approval']],
  );
  assert.equal(home.attention[0]?.kind, 'approval');
  assert.equal(home.health.overall, 'unknown');

  const response = await api.get(`/api/v1/tasks/${task.id}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const detail = JSON.parse(text) as TaskDetailV1;
  assert.equal(detail.apiVersion, 1);
  assert.equal(detail.id, task.id);
  assert.equal(detail.header.title, 'Guided greeting');
  assert.ok(detail.workflow.length >= 6);
  assert.equal(detail.details.scope, null);
  assert.doesNotMatch(text, /"files":\[\{"path"/, 'no snapshot file inventory');
  assert.doesNotMatch(text, /"stdout"|"stderr"/, 'no raw check output');
  assert.equal(detail.details.timeline.path, `/api/v1/tasks/${task.id}/timeline`);

  const first = (await (await api.get(`${detail.details.timeline.path}?limit=1`)).json()) as TimelinePageV1;
  assert.equal(first.apiVersion, 1);
  assert.equal(first.entries.length, 1);
  assert.equal(first.total, detail.details.timeline.total);
  assert.ok(first.total >= 2, 'creation journals more than one event');
  assert.equal(first.entries[0]?.type, 'guided.created');
  assert.equal(first.entries[0]?.summary, 'Plan prepared for approval');
  assert.equal(first.entries[0]?.reasonCode, 'APPROVAL_REQUIRED');
  assert.notEqual(first.nextCursor, null);
  const older = (await (
    await api.get(`${detail.details.timeline.path}?cursor=${first.nextCursor}&limit=200`)
  ).json()) as TimelinePageV1;
  assert.equal(older.entries.length, first.total - 1);
  assert.equal(older.nextCursor, null);
  assert.ok(older.entries.every(entry => entry.sequence < first.entries[0]!.sequence));
  const invalid = await failure(await api.get(`${detail.details.timeline.path}?limit=0`), 400, 'invalid_request');
  assert.ok(invalid.error.issues?.some(issue => issue.startsWith('limit')));
  await failure(await api.get(`/api/v1/tasks/${task.id}/changes`), 400, 'invalid_request');
  await failure(await api.get(`/api/v1/tasks/${task.id}/changes?path=greeting.js`), 404, 'not_found');
});

test('an action is posted exactly as its ActionView request describes, and a stale one is refused', async t => {
  const api = await dashboard(t);
  const task = api.f.tasks.create(api.f.plan);
  const read = async () => (await (await api.get(`/api/v1/tasks/${task.id}`)).json()) as TaskDetailV1;
  const draft = await read();
  const approve = draft.decisions.find(item => item.id === 'approve')!;
  assert.equal(approve.request.method, 'POST');
  const approved = await api.post(approve.request.path, approve.request.body);
  assert.equal(approved.status, 200, await approved.clone().text());
  const ready = await read();
  assert.equal(ready.header.status, 'idle');
  assert.equal(ready.header.statusLabel, 'Ready to continue');
  assert.deepEqual(ready.header.nextStep, { kind: 'human', label: 'Continue the task.', actionIds: ['run'] });
  assert.equal(ready.workflow[0]?.state, 'passed');
  const stale = await api.post(approve.request.path, approve.request.body);
  assert.equal(stale.status, 409, 'the decision key no longer matches the task');
  const deleted = ready.decisions.find(item => item.id === 'delete')!;
  assert.ok(deleted.confirm);
  assert.equal((await api.post(deleted.request.path, deleted.request.body)).status, 200);
  await failure(await api.get(`/api/v1/tasks/${task.id}`), 404, 'not_found');
});
