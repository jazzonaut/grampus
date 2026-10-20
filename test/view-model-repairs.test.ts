// Repair decisions expose progress evidence and the exact remaining allowance without inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairDecision, repairsView } from '../src/server/view-model/repairs.js';
import { timelineEntry } from '../src/server/view-model/timeline.js';
import { fixture } from './helpers/guided-tasks.js';

test('repair decisions explain their trigger, progress and budget in the task and timeline', t => {
  const f = fixture(t);
  const task = f.tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'supervised', readinessRounds: 2, repairRounds: 3 },
  });
  f.tasks.approve(task.id, task.version, task.guided!.digest);
  const id = task.id,
    state = f.tasks.get(id);
  assert.equal(state.plan.workflowPolicy.repairRounds, 3);
  assert.equal(state.plan.workflowPolicy.readinessRounds, 2);
  f.store.append(id, 1, 'guided.repair_decided', {
    source: 'review',
    action: 'repair',
    reason: 'REVIEW_BLOCKING_FINDINGS',
    progress: 'progress',
    sliceIndex: 0,
    used: 1,
    allowance: 3,
    resultId: 'review-2',
    trigger: 'The retry path drops the original error. Evidence: src/export.ts:42',
    artifact: 'sha256:current',
  });
  const event = f.store.events(id).at(-1)!;
  const decision = repairDecision(event)!;
  assert.equal(decision.title, 'Independent review: Automatic repair');
  assert.match(decision.progress, /agent assessment/);
  assert.match(decision.budget, /1 of 3.*1 remaining afterwards/);
  assert.equal(decision.resultId, 'review-2');
  assert.match(decision.trigger, /retry path drops the original error/);
  const view = repairsView(f.store.events(id), { ...state, repairCycle: { used: 2, failures: [] } });
  assert.equal(view.remaining, 1);
  assert.equal(view.decisions.length, 1);
  assert.deepEqual(view.readiness, { used: 0, allowance: 2, remaining: 2, checks: 0 });
  assert.equal(timelineEntry(event).summary, decision.title);
  assert.match(timelineEntry(event).note!, /remaining afterwards/);
  assert.equal(repairsView(f.store.events(id), { ...state, sliceIndex: 1 }).decisions.length, 0);
  assert.equal(repairsView(f.store.events(id), { ...state, version: 2 }).decisions.length, 0);
});

test('repair history shows observed results from the next attempt without claiming changed bytes fixed it', t => {
  const f = fixture(t),
    id = f.create(),
    state = f.tasks.get(id);
  const decision = {
    source: 'readiness',
    action: 'repair',
    reason: 'CHECK_FAILED',
    progress: 'initial',
    sliceIndex: 0,
    used: 0,
    allowance: 2,
    resultId: 'format-failed',
    trigger: 'Formatting rejected greeting.js',
    artifact: 'sha256:before',
  };
  f.store.append(id, 1, 'guided.repair_decided', decision);
  f.store.append(id, 1, 'check.requested', {
    executionId: 'unrelated',
    checkId: 'foreign',
    spec: { name: 'Unrelated check', artifact: 'sha256:foreign' },
  });
  f.store.append(id, 1, 'check.settled', { checkId: 'foreign', phase: 'passed' });
  f.store.append(id, 1, 'execution.created', {
    id: 'repair',
    role: 'implementation',
    attemptId: 'repair-attempt',
    sliceIndex: 0,
  });
  f.store.append(id, 1, 'guided.step_finished', { stage: 'scope', executionId: 'repair', sliceIndex: 0 });
  f.store.append(id, 1, 'check.requested', {
    executionId: 'unrelated',
    checkId: 'foreign-after',
    spec: { name: 'Another unrelated check', artifact: 'sha256:foreign' },
  });
  f.store.append(id, 1, 'check.settled', { checkId: 'foreign-after', phase: 'passed' });
  f.store.append(id, 1, 'check.requested', {
    executionId: 'repair',
    checkId: 'format-pass',
    spec: { name: 'Format', artifact: 'sha256:after', readiness: 'format' },
  });
  f.store.append(id, 1, 'check.settled', { checkId: 'format-pass', phase: 'passed' });
  f.store.append(id, 1, 'check.requested', {
    executionId: 'repair',
    checkId: 'types-failed',
    spec: { name: 'Types', artifact: 'sha256:after', readiness: 'types' },
  });
  f.store.append(id, 1, 'check.settled', { checkId: 'types-failed', phase: 'failed' });
  f.store.append(id, 1, 'evidence.recorded', {
    id: 'foreign-review',
    kind: 'review',
    attemptId: 'foreign-attempt',
    outcome: 'passed',
    artifact: 'sha256:foreign',
  });
  f.store.append(id, 1, 'task.completed', { attemptId: 'foreign-attempt', artifact: 'sha256:foreign' });
  f.store.append(id, 1, 'guided.repair_decided', { ...decision, resultId: 'types-failed', used: 1 });
  f.store.append(id, 1, 'check.requested', {
    checkId: 'later',
    spec: { name: 'Later check', artifact: 'sha256:later' },
  });
  f.store.append(id, 1, 'check.settled', { checkId: 'later', phase: 'passed' });
  const view = repairsView(f.store.events(id), state);
  const first = view.decisions.find(item => item.resultId === 'format-failed')!;
  assert.deepEqual(first.results, [
    { name: 'Format', outcome: 'passed', artifact: 'sha256:after' },
    { name: 'Types', outcome: 'failed', artifact: 'sha256:after' },
  ]);
  assert.match(first.budget, /Readiness: 0 of 2/);
  assert.doesNotMatch(first.outcome, /verified and delivered/);
});
