import { acceptanceScenarios } from './helpers/task-fixture.js';
// Dashboard views of a task mid-flight: the pipeline strip, rounds, worker messages with answers, and the
// state of queued commands, all derived from the same log the driver reads.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listItem, pipelineOf, specSection, taskDetail } from '../src/dashboard/views.js';
import type { CheckResult, UserCommand } from '../src/domain/events.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { foldEvents } from '../src/pipeline/state.js';
import { TaskStore } from '../src/store/task-store.js';

const check = (passed: boolean): CheckResult => ({
  name: 'unit',
  command: 'npm test',
  exitCode: passed ? 0 : 1,
  timedOut: false,
  durationMs: 1200,
  logPath: 'unit.log',
  flaky: false,
  passed,
});

function taskInRepair(): TaskStore {
  const store = TaskStore.create(mkdtempSync(join(tmpdir(), 'grampus-views-')), 'task-1');
  store.append({
    type: 'task.created',
    taskId: 'task-1',
    title: 'T',
    request: 'R',
    repoPath: 'C:/repo',
    recipe: pipelineRecipe,
  });
  store.append({ type: 'stage.created', key: 'spec:1', stage: 'spec', round: 1, orcaTaskId: 'o1' });
  store.append({
    type: 'stage.started',
    key: 'spec:1',
    dispatchId: 'd1',
    assignment: { agent: 'claude' },
    reusedHandle: null,
    launch: null,
  });
  store.append({
    type: 'worker.message',
    messageId: 'm1',
    key: 'spec:1',
    kind: 'question',
    subject: 'Trim?',
    body: 'Trim spaces?',
  });
  const reply: UserCommand = {
    id: '7a4b4f3e-6b2a-4c3e-9d1a-2b3c4d5e6f70',
    at: '2026-10-22T10:00:00.000Z',
    source: 'chat',
    kind: 'reply',
    messageId: 'm1',
    body: 'Yes',
  };
  store.addCommand(reply);
  store.append({ type: 'command.applied', command: reply });
  store.append({
    type: 'stage.settled',
    key: 'spec:1',
    dispatchId: 'd1',
    messageId: 'm2',
    outcome: 'succeeded',
    subject: 'Spec written',
    body: '',
  });
  store.append({
    type: 'spec.recorded',
    acceptance: acceptanceScenarios(),
    key: 'spec:1',
    version: 1,
    hash: 'h',
    path: 'missing.md',
    checks: [{ name: 'unit', command: 'npm test' }],
    protected: [],
  });
  const approve: UserCommand = {
    id: '8a4b4f3e-6b2a-4c3e-9d1a-2b3c4d5e6f70',
    at: '2026-10-22T10:01:00.000Z',
    source: 'dashboard',
    kind: 'approve',
    specVersion: 1,
  };
  store.addCommand(approve);
  store.append({ type: 'command.applied', command: approve });
  store.append({
    type: 'checks.recorded',
    specVersion: 1,
    phase: 'baseline',
    round: 0,
    sha: 'a',
    results: [check(false)],
  });
  store.append({ type: 'stage.created', key: 'build:0', stage: 'build', round: 0, orcaTaskId: 'o2' });
  store.append({
    type: 'stage.started',
    key: 'build:0',
    dispatchId: 'd2',
    assignment: { agent: 'codex' },
    reusedHandle: null,
    launch: null,
  });
  store.append({
    type: 'stage.settled',
    key: 'build:0',
    dispatchId: 'd2',
    messageId: 'm3',
    outcome: 'succeeded',
    subject: 'Built',
    body: '',
  });
  store.append({
    type: 'guard.recorded',
    specVersion: 1,
    round: 0,
    fromSha: 'a',
    sha: 'b',
    guard: { clean: true, commits: 1, changedFiles: ['x.js'], violations: [], modifiedTests: [] },
  });
  store.append({
    type: 'checks.recorded',
    specVersion: 1,
    phase: 'verify',
    round: 0,
    sha: 'b',
    results: [check(false)],
  });
  store.append({
    type: 'round.decided',
    specVersion: 1,
    sha: 'b',
    round: 0,
    decision: 'repair',
    reasons: ['check unit failed'],
  });
  store.append({ type: 'stage.created', key: 'repair:1', stage: 'repair', round: 1, orcaTaskId: 'o3' });
  store.append({
    type: 'stage.started',
    key: 'repair:1',
    dispatchId: 'd3',
    assignment: null,
    reusedHandle: 'h1',
    launch: null,
  });
  return store;
}

test('the pipeline strip shows where a task in repair stands', () => {
  const state = foldEvents(taskInRepair().events());
  const steps = Object.fromEntries(pipelineOf(state).map(step => [step.id, step]));
  assert.equal(steps['spec']?.state, 'done');
  assert.equal(steps['spec-review']?.state, 'pending', 'the standard recipe reviews specs; none ran here');
  assert.equal(steps['approve']?.state, 'done');
  assert.equal(steps['approve']?.detail, 'v1');
  assert.equal(steps['tests']?.state, 'skipped');
  assert.equal(steps['baseline']?.detail, '0/1 pass before the change');
  assert.equal(steps['build']?.state, 'done');
  assert.equal(steps['repair']?.state, 'running');
  assert.equal(steps['accept']?.state, 'pending');
});

test('task detail pairs questions with answers, rounds with evidence, and queued commands with their state', () => {
  const store = taskInRepair();
  const queued: UserCommand = {
    id: '9a4b4f3e-6b2a-4c3e-9d1a-2b3c4d5e6f70',
    at: '2026-10-22T10:05:00.000Z',
    source: 'dashboard',
    kind: 'abandon',
  };
  store.addCommand(queued);
  const events = store.events();
  const detail = taskDetail(foldEvents(events), events, store.commands());

  assert.equal(detail.messages[0]?.answer?.body, 'Yes');
  assert.equal(detail.messages[0]?.answer?.source, 'chat');
  assert.equal(detail.specs[0]?.text, null, 'a missing spec file is reported, not invented');
  assert.equal(detail.rounds[0]?.decision?.decision, 'repair');
  assert.equal(detail.rounds[0]?.checks?.results[0]?.passed, false);
  assert.equal(detail.rounds[1]?.stageKey, 'repair:1');
  assert.equal(detail.stages.find(stage => stage.key === 'repair:1')?.dispatches[0]?.reused, true);
  assert.deepEqual(
    detail.commands.map(command => [command.kind, command.state]),
    [
      ['reply', 'applied'],
      ['approve', 'applied'],
      ['abandon', 'queued'],
    ],
  );
  assert.equal(detail.status, 'running');
  assert.ok(detail.timeline.some(item => item.title === 'Round 0: repair' && item.tone === 'warning'));
});

test('a question whose worker finished before it was answered is closed, not waiting for the user', () => {
  const store = taskInRepair();
  store.append({
    type: 'worker.message',
    messageId: 'm4',
    key: 'repair:1',
    kind: 'question',
    subject: 'Offsets?',
    body: 'Accept numeric offsets?',
  });
  store.append({
    type: 'stage.settled',
    key: 'repair:1',
    dispatchId: 'd3',
    messageId: 'm5',
    outcome: 'succeeded',
    subject: 'Repaired',
    body: '',
  });
  const events = store.events();
  const state = foldEvents(events);
  const detail = taskDetail(state, events, store.commands());

  assert.equal(detail.messages.find(message => message.messageId === 'm4')?.closed, true);
  assert.equal(detail.summary.questions.length, 0);
  assert.equal(listItem(state, events).openQuestions, 0);
  assert.equal(detail.status, 'running');
});

test("a worker's question stays open when an earlier worker on the same stage ends", () => {
  const store = taskInRepair();
  store.append({ type: 'stage.stopped', key: 'repair:1', dispatchId: 'd3', reason: 'retried' });
  store.append({
    type: 'stage.started',
    key: 'repair:1',
    dispatchId: 'd4',
    assignment: null,
    reusedHandle: null,
    launch: null,
  });
  store.append({
    type: 'worker.message',
    messageId: 'm4',
    key: 'repair:1',
    kind: 'question',
    subject: 'Offsets?',
    body: 'Accept numeric offsets?',
  });
  store.append({ type: 'stage.exited', key: 'repair:1', dispatchId: 'd3' });
  const events = store.events();
  const state = foldEvents(events);

  assert.equal(listItem(state, events).openQuestions, 1);
  assert.equal(taskDetail(state, events, store.commands()).status, 'needs-you');
});

test("an escalated round keeps the builder's failure report apart from the other reasons", () => {
  const store = taskInRepair();
  store.append({
    type: 'round.decided',
    specVersion: 1,
    sha: 'b',
    round: 1,
    decision: 'escalate',
    reasons: ['the builder reported failure: Added X; the check exits 8.', 'check "unit" failed'],
  });
  const events = store.events();
  const detail = taskDetail(foldEvents(events), events, store.commands());

  assert.deepEqual(detail.rounds[1]?.decision, {
    decision: 'escalate',
    reasons: ['check "unit" failed'],
    builderFailure: 'Added X; the check exits 8.',
  });
  assert.equal(detail.rounds[0]?.decision?.builderFailure, null);
});

test("a spec's Outcome section is read up to the next heading or the grampus block", () => {
  const spec =
    '# Unlock\r\n## Outcome\r\nParents can lift limits.\r\n\r\nUntil midnight.\r\n## Acceptance criteria\r\n1. x\r\n';
  assert.equal(specSection(spec, 'Outcome'), 'Parents can lift limits.\n\nUntil midnight.');
  assert.equal(specSection('# T\n## Outcome\nLast.\n```grampus\n{}\n```\n', 'Outcome'), 'Last.');
  assert.equal(specSection('# T\n## Outcome\n\n## Examples\n', 'Outcome'), null, 'an empty section is missing');
  assert.equal(specSection('# T\nNo sections.', 'Outcome'), null);
});
