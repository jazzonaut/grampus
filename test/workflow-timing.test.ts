// Verifies disjoint stage timing across pauses, retries, live work and recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowTiming } from '../src/reporting/workflow-timing.js';

test('workflow timing includes every stage and separates waiting and recovery without double counting', () => {
  const origin = Date.parse('2026-10-20T10:00:00Z');
  const at = (ms: number) => new Date(origin + ms).toISOString();
  const events = [
    [0, 'workspace', 'draft', null],
    [100, 'workspace', 'running', {}],
    [150, 'implementation', 'running', {}],
    [300, 'implementation', 'blocked', {}],
    [500, 'implementation', 'running', {}],
    [550, 'implementation', 'recovery_required', {}],
    [750, 'readiness', 'running', {}],
    [800, 'delivery', 'running', {}],
    [900, 'complete', 'complete', {}],
  ].map(([ms, stage, status, owner], sequence) => ({
    sequence,
    taskId: 'task',
    version: 1,
    at: at(ms as number),
    type: 'guided.step_requested',
    data: { stage, status, owner, sliceIndex: 0, pending: null },
  }));
  const timing = workflowTiming(events, at(2000));
  assert.equal(timing.elapsedMs, 900);
  assert.equal(timing.activeMs, 400);
  assert.equal(timing.waitingMs, 300);
  assert.equal(timing.recoveryMs, 200);
  assert.equal(timing.live, false);
  assert.equal(timing.stages.find(row => row.stage === 'implementation')?.activeMs, 200);
  const live = workflowTiming(events.slice(0, 3), at(250));
  assert.equal(live.elapsedMs, 250);
  assert.equal(live.activeMs, 150);
  assert.equal(live.live, true);
  assert.equal(workflowTiming([]).elapsedMs, null);
  assert.equal(workflowTiming(events.slice(0, 3), at(125)).clockAdjusted, true);
});

test('individual step timing preserves recovered gaps and freezes at the first completion transition', () => {
  const base = Date.parse('2026-10-20T10:00:00Z');
  const at = (ms: number) => new Date(base + ms).toISOString();
  const rows: [number, string, string, string, boolean][] = [
    [0, 'guided.created', 'workspace', 'draft', false],
    [100, 'guided.step_requested', 'implementation', 'running', true],
    [1000, 'guided.controller_claimed', 'implementation', 'running', true],
    [1050, 'guided.step_reconciled', 'validation', 'ready', false],
    [1100, 'guided.step_requested', 'validation', 'running', true],
    [1200, 'guided.step_finished', 'complete', 'complete', false],
    [1300, 'guided.controller_checkpoint', 'complete', 'complete', false],
  ];
  const events = rows.map(([ms, type, stage, status, pending], sequence) => ({
    taskId: 'task',
    version: 1,
    sequence,
    at: at(ms),
    type,
    data: {
      stage,
      status,
      sliceIndex: 0,
      owner: status === 'draft' ? null : {},
      pending: pending ? {} : null,
      recovering: type === 'guided.controller_claimed',
    },
  }));
  const result = workflowTiming(events, at(5000));
  assert.equal(result.elapsedMs, 1200);
  assert.equal(result.activeMs, 200);
  assert.equal(result.waitingMs, 100);
  assert.equal(result.recoveryMs, 900);
  assert.equal(result.completedAt, at(1200));
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0]!.recoveryMs, 900);
  assert.equal(result.steps[0]!.finishedAt, at(1050));
  assert.equal(result.steps[1]!.activeMs, 100);
});
