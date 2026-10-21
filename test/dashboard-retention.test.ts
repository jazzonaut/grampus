// Dashboard retention regression: repository evidence stays in SQLite instead of being duplicated
// into the overview and task caches as the check history grows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers/checks.js';
import { guidedRecord, planRecord } from './helpers/task-records.js';
import { taskFacts } from '../src/server/view-model/task-detail.js';
import { createApiV1 } from '../src/server/api-v1.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { BoundaryError } from '../src/process/boundary.js';
import type { RepositoryCheck } from '../src/persistence/records.js';
import type { OverviewV1, TaskDetailV1 } from '../src/server/api-types.js';

test('dashboard caches exclude historical check snapshots across journal revisions', async t => {
  const f = await fixture(t);
  const snapshot = await f.checks.snapshot(f.execution.id);
  const content = 'historical repository evidence\n'.repeat(16_384);
  snapshot.diff.push({
    path: 'large.txt',
    before: null,
    after: 'fixture',
    encoding: 'utf8',
    content,
    previousEncoding: 'utf8',
    previousContent: null,
  });
  const task = f.store.get(f.task.id);
  task.guided = guidedRecord({
    plan: planRecord({ brief: task.brief }),
    workspaceId: f.workspace.id,
    executionId: f.execution.id,
    status: 'running',
    stage: 'validation',
  });
  const check: RepositoryCheck = {
    id: randomUUID(),
    executionId: f.execution.id,
    phase: 'failed',
    spec: { ...(await f.spec()), name: 'Retained validation' },
    before: snapshot,
    after: snapshot,
    supervisorPid: null,
    toolPid: null,
    result: {
      reason: 'exited',
      exitCode: 1,
      exitConfirmed: true,
      stdout: 'check output',
      stderr: 'Error: useful failure',
      outputTruncated: false,
    },
    error: null,
    purpose: 'validation',
    dispatch: 'requested',
  };
  f.store.transaction(() => {
    f.store.save(task.id, task);
    for (let i = 0; i < 8; i++) {
      const id = i === 0 ? check.id : randomUUID();
      f.store.saveCheck(id, f.execution.id, { ...check, id });
    }
  });
  const api = createApiV1({
    store: f.store,
    kickoffs: new Kickoffs(f.store),
    jobs: new Map(),
    stalls: { stall: () => null },
    now: Date.now,
    settingsDirectory: null,
  });
  for (let revision = 0; revision < 3; revision++) {
    f.store.transaction(() => f.store.append(task.id, task.version, 'test.updated', { revision }));
    const facts = taskFacts(f.store, task.id);
    assert.ok(JSON.stringify(facts).length < 64 * 1024, 'cached facts must not grow with repository bytes per check');
    const overviewPath = '/api/v1/overview';
    const overview = (await api.get(overviewPath, new URL(overviewPath, 'http://localhost'))) as OverviewV1;
    assert.equal(overview.tasks[0]?.id, task.id);
    const path = `/api/v1/tasks/${task.id}`;
    const detail = (await api.get(path, new URL(path, 'http://localhost'))) as TaskDetailV1;
    assert.equal(detail.results.checks.length, 8);
    assert.equal(detail.results.checks[0]?.issue, 'Error: useful failure');
    assert.equal(detail.results.checks[0]?.stdoutCharacters, 'check output'.length);
    assert.doesNotMatch(JSON.stringify(detail), /historical repository evidence/);
  }
  assert.equal(f.store.check(check.id).before?.diff.at(-1)?.content, content, 'full evidence remains readable');
  assert.equal(f.store.checks(f.execution.id)[0]?.after?.diff.at(-1)?.content, content);
  const summaries = f.store.checkSummaries(f.execution.id);
  assert.deepEqual(
    summaries.map(item => item.id),
    f.store.checks(f.execution.id).map(item => item.id),
  );
  assert.ok(summaries.every(item => !('before' in item) && !('after' in item)));
  assert.deepEqual(f.store.checkSummaries('missing-execution'), []);
  f.store.transaction(() =>
    f.store.saveCheck(check.id, f.execution.id, {
      ...check,
      spec: { ...check.spec, name: null },
    } as unknown as RepositoryCheck),
  );
  assert.throws(() => f.store.checkSummaries(f.execution.id), BoundaryError, 'malformed metadata stays unknown');
});
