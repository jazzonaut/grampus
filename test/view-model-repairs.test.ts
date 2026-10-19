// Repair decisions expose progress evidence and the exact remaining allowance without inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairDecision, repairsView } from '../src/server/view-model/repairs.js';
import { timelineEntry } from '../src/server/view-model/timeline.js';
import { fixture } from './helpers/guided-tasks.js';

test('repair decisions explain their trigger, progress and budget in the task and timeline', t => {
  const f = fixture(t);
  const id = f.create(),
    state = f.tasks.get(id);
  assert.equal(state.plan.workflowPolicy.repairRounds, 3);
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
  assert.equal(timelineEntry(event).summary, decision.title);
  assert.match(timelineEntry(event).note!, /remaining afterwards/);
  assert.equal(repairsView(f.store.events(id), { ...state, sliceIndex: 1 }).decisions.length, 0);
  assert.equal(repairsView(f.store.events(id), { ...state, version: 2 }).decisions.length, 0);
});
