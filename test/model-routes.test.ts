// HTTP boundaries for profile snapshots, comparison approval and complete run exports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startUi } from '../src/server/ui-server.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { Sessions } from '../src/execution/sessions.js';
import { Comparisons } from '../src/orchestration/comparisons.js';
import { comparisonDecisionKey } from '../src/domain/comparison.js';
import { exportRun } from '../src/reporting/run-export.js';
import { runMetrics } from '../src/reporting/run-metrics.js';
import { profile } from './helpers/model-profiles.js';
import { fixture } from './helpers/guided-tasks.js';
import type { ComparisonV1, ModelProfilesV1 } from '../src/server/api-types.js';

test('profiles save with stale-write protection and exports preserve the full session history', async t => {
  const cleanups: (() => void)[] = [],
    f = fixture({ after: fn => cleanups.push(fn) });
  const ui = await startUi({ db: f.store.path, port: 0, settingsDirectory: f.root });
  t.after(async () => {
    await ui.close();
    for (const cleanup of cleanups) cleanup();
  });
  const url = new URL(ui.url),
    headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const get = (path: string) => fetch(url.origin + path, { headers });
  const post = (path: string, body: unknown) =>
    fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const catalogue = (await (await get('/api/v1/model-profiles')).json()) as ModelProfilesV1;
  assert.equal((await post('/api/model-profiles', { expected: catalogue.expected, profiles: [profile] })).status, 200);
  assert.equal((await post('/api/model-profiles', { expected: catalogue.expected, profiles: [] })).status, 409);
  const saved = (await (await get('/api/v1/model-profiles')).json()) as ModelProfilesV1;
  assert.equal(saved.profiles[0]?.name, 'Balanced');
  const planning = new Kickoffs(f.store).create({
    repo: f.repo,
    request: 'Plan a greeting',
    modelProfile: saved.profiles[0],
  });
  assert.equal(f.store.session(planning).model, 'planner');
  assert.equal(f.store.session(planning).effort, 'high');
  const task = f.tasks.create(f.plan);
  const session = new Sessions(f.store).create('codex', f.repo);
  f.store.append(task.id, 1, 'guided.kickoff_linked', { sessionId: session.id });
  const long = 'retained output beyond the preview '.repeat(4000);
  f.store.appendSession(session.id, 'output.delta', { text: long });
  const response = await get(`/api/tasks/${task.id}/export`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
  const exported = await response.json();
  assert.equal(exported.sessions[0].events.at(-1).data.text, long);
  assert.equal(exported.metrics.subscriptionAllowanceConsumed, null);
  const compressed = Buffer.from(await (await get(`/api/tasks/${task.id}/export?format=gzip`)).arrayBuffer());
  assert.equal(JSON.parse(gunzipSync(compressed).toString()).task.id, task.id);
  assert.match(await (await get(`/api/tasks/${task.id}/export?format=csv`)).text(), /tokenCompleteness/);
  assert.equal((await fetch(url.origin + `/api/tasks/${task.id}/export`)).status, 401);
  const other = { ...profile, id: 'other', name: 'Other' };
  const created = await post('/api/comparisons', {
    sourceTaskId: task.id,
    expectedDigest: task.guided!.digest,
    profiles: [profile, other],
  });
  assert.equal(created.status, 200);
  const group = await created.json();
  const before = (await (await get(`/api/v1/comparisons/${group.id}`)).json()) as ComparisonV1;
  const approve = before.actions.find(action => action.id === 'approve')!;
  assert.equal((await post(approve.request.path, approve.request.body)).status, 200);
  assert.equal((await post(approve.request.path, approve.request.body)).status, 409);
  assert.equal((await get(`/api/comparisons/${group.id}/export`)).status, 200);
});

test('unknown usage remains unknown, and full export includes raw logs beyond the SQLite preview', t => {
  const f = fixture(t),
    task = f.tasks.create(f.plan);
  assert.equal(runMetrics(f.store, task.id).usage.headline.tokens, null);
  assert.equal(runMetrics(f.store, task.id).subscription.rejectedTurns, null);
  const result = exportRun(f.store, task.id);
  assert.equal(result.metrics.billedCostUsd, null);
  assert.equal(result.metrics.verifiedDelivery, false);
  writeFileSync(join(f.root, 'unrelated'), 'not an export attachment');
  assert.equal(result.attachments.length, 0);
});

test('driver recovery never repeats a turn and future members cannot bypass batch order', async t => {
  const f = fixture(t),
    source = f.tasks.create(f.plan),
    comparisons = new Comparisons(f.store);
  const group = comparisons.create(source.id, source.guided!.digest, [profile, { ...profile, id: 'other' }]);
  comparisons.approve(group.id, comparisonDecisionKey(group));
  const value = f.store.comparison(group.id);
  value.owner = {
    token: 'driver',
    controllerPid: process.pid,
    controllerStartedAt: null,
    host: (await import('node:os')).hostname(),
  };
  value.status = 'running';
  f.store.saveComparison(value);
  assert.throws(() => comparisons.recover(group.id, comparisonDecisionKey(value)), /alive/);
  assert.equal(f.store.sessions().length, 0);
  const after = f.store.comparison(group.id);
  assert.equal(after.owner?.token, 'driver');
});

test('batch approval refuses a displayed shared plan that no longer matches its frozen digest', t => {
  const f = fixture(t),
    source = f.tasks.create(f.plan),
    comparisons = new Comparisons(f.store);
  const group = comparisons.create(source.id, source.guided!.digest, [profile, { ...profile, id: 'second' }]);
  group.plan.brief.outcome = 'Altered displayed work';
  f.store.saveComparison(group);
  assert.throws(() => comparisons.approve(group.id, comparisonDecisionKey(group)), /changed/);
  for (const run of group.runs) assert.equal(f.store.get(run.taskId).approvedVersion, null);
});
