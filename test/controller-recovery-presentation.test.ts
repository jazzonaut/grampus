// A journal owner whose original process has disappeared must be presented as recovery, without changing truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { guidedRecord, taskRecord, planRecord } from './helpers/task-records.js';
import { guidedPlanDigest } from '../src/domain/guided-plan.js';
import { taskDetail, taskFacts } from '../src/server/view-model/task-detail.js';
import { ControllerObservations } from '../src/health/controller-observations.js';
import { createApiV1 } from '../src/server/api-v1.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { randomUUID } from 'node:crypto';
import type { TaskDetailV1 } from '../src/server/api-types.js';
import { stallLimits } from '../src/config/limits.js';

test('a missing original controller overrides the running label and offers recovery first', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-owner-view-')),
    store = new Store(join(root, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const plan = planRecord(),
    digest = guidedPlanDigest(plan);
  const owner = { token: 'owner', controllerPid: process.pid, controllerStartedAt: null, host: hostname() };
  const guided = guidedRecord({ plan, digest, approvedDigest: digest, status: 'running', owner });
  store.transaction(() => store.save('task', taskRecord('task', { approvedVersion: 1, guided })));
  const context = {
    job: () => null,
    stall: () => null,
    qualityPasses: [],
    pool: { active: 1, limit: 2, owners: ['task'] },
    controller: () => 'absent' as const,
  };
  const before = store.revision();
  const view = taskDetail(taskFacts(store, 'task'), context, before);
  assert.equal(view.header.status, 'blocked');
  assert.match(view.header.statusLabel, /recovery/i);
  assert.equal(view.decisions[0]?.id, 'recover');
  assert.equal(store.get('task').guided?.status, 'running');
  assert.equal(store.revision(), before, 'observing a dead owner must not release ownership or replay work');
});

test('the API refreshes owner identity independently of its unchanged journal revision cache', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-owner-api-')),
    store = new Store(join(root, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const plan = planRecord(),
    digest = guidedPlanDigest(plan),
    id = randomUUID();
  const owner = { token: 'owner', controllerPid: process.pid, controllerStartedAt: 'original', host: hostname() };
  store.transaction(() =>
    store.save(
      id,
      taskRecord(id, {
        approvedVersion: 1,
        guided: guidedRecord({ plan, digest, approvedDigest: digest, status: 'running', owner }),
      }),
    ),
  );
  let now = 0,
    alive = true;
  const controllers = new ControllerObservations(
    async () => (alive ? { state: 'present', startedAt: 'original' } : { state: 'absent' }),
    () => now,
  );
  const api = createApiV1(
    {
      store,
      kickoffs: new Kickoffs(store),
      jobs: new Map(),
      stalls: { stall: () => null },
      now: () => now,
      settingsDirectory: null,
    },
    controllers,
  );
  const path = '/api/v1/tasks/' + id,
    url = new URL('http://localhost' + path),
    before = store.revision();
  await controllers.refresh([owner]);
  assert.equal(((await api.get(path, url)) as TaskDetailV1).header.status, 'working');
  now += stallLimits.scanIntervalMs;
  alive = false;
  await controllers.refresh([owner]);
  const view = (await api.get(path, url)) as TaskDetailV1;
  assert.equal(view.header.status, 'blocked');
  assert.equal(view.decisions[0]?.id, 'recover');
  assert.equal(store.revision(), before);
});
