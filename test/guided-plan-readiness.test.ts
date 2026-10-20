// Approval binds mechanical check categories and both allowances; existing validation is never reclassified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidedPlanDigest, normalizeGuidedPlan } from '../src/domain/guided-plan.js';
import { pendingReadiness } from '../src/domain/readiness.js';
import { normalizeWorkflowPolicy } from '../src/domain/workflow-policy.js';
import { fixture } from './helpers/guided-tasks.js';
import type { RepositoryCheck } from '../src/persistence/records.js';

test('an automatic formatter is an explicit approved command', t => {
  const f = fixture(t);
  const formatting = {
    name: 'Format authorised files',
    file: 'node',
    args: ['format.js', 'greeting.js'],
    timeoutMs: 1000,
  };
  const input = { ...f.plan, slices: [{ ...f.plan.slices[0], formatting }] };
  const plan = normalizeGuidedPlan(input);
  assert.deepEqual(plan.slices[0]!.formatting, { ...formatting, file: process.execPath });
  assert.notEqual(guidedPlanDigest(plan), guidedPlanDigest(normalizeGuidedPlan(f.plan)));
});

test('readiness commands and allowances are explicit parts of approval', t => {
  const f = fixture(t);
  const command = { kind: 'types', name: 'Types', file: 'node', args: ['--check', 'greeting.js'], timeoutMs: 1000 };
  const input = { ...f.plan, slices: [{ ...f.plan.slices[0], readiness: [command] }] };
  const plan = normalizeGuidedPlan(input);
  assert.deepEqual(plan.slices[0]!.readiness, [{ ...command, kind: 'types', file: process.execPath }]);
  assert.equal(plan.workflowPolicy.readinessRounds, 5);
  assert.equal(plan.workflowPolicy.repairRounds, 5);
  const changedBudget = normalizeGuidedPlan({ ...input, workflowPolicy: { readinessRounds: 4 } });
  assert.notEqual(guidedPlanDigest(plan), guidedPlanDigest(changedBudget));
  const changedKind = normalizeGuidedPlan({
    ...input,
    slices: [{ ...f.plan.slices[0], readiness: [{ ...command, kind: 'lint' }] }],
  });
  assert.notEqual(guidedPlanDigest(plan), guidedPlanDigest(changedKind));
  assert.deepEqual(normalizeGuidedPlan(f.plan).slices[0]!.readiness, []);
  for (const readinessRounds of [-1, 11, 1.5, '2', null])
    assert.throws(() => normalizeWorkflowPolicy({ readinessRounds }), /readinessRounds/);
});

test('readiness refuses ambiguous categories, duplicate names and acceptance or preparation options', t => {
  const f = fixture(t);
  const command = { kind: 'format', name: 'Format', file: 'node', args: [] };
  const normalise = (readiness: unknown) =>
    normalizeGuidedPlan({ ...f.plan, slices: [{ ...f.plan.slices[0], readiness }] });
  for (const checks of [
    [{ ...command, kind: 'test' }],
    [command, command],
    [command, { ...command, kind: 'lint' }],
    [{ ...command, expectedStdout: '' }],
    [{ ...command, preparation: {} }],
    command,
  ])
    assert.throws(() => normalise(checks), /readiness/);
});

test('readiness evidence must name the exact command, artifact and instructions', t => {
  const f = fixture(t);
  const commands = normalizeGuidedPlan({
    ...f.plan,
    slices: [{ ...f.plan.slices[0], readiness: [{ kind: 'types', file: 'node', args: ['--check', 'greeting.js'] }] }],
  }).slices[0]!.readiness;
  const snapshot = { artifact: 'sha256:current', instructionsDigest: 'current' };
  const spec = pendingReadiness(commands, snapshot, [])!;
  const passed = { phase: 'passed' as const, spec };
  assert.equal(pendingReadiness(commands, snapshot, [passed]), null);
  assert.ok(pendingReadiness(commands, { ...snapshot, artifact: 'sha256:changed' }, [passed]));
  assert.ok(pendingReadiness(commands, { ...snapshot, instructionsDigest: 'changed' }, [passed]));
  assert.ok(pendingReadiness(commands, snapshot, [{ ...passed, phase: 'failed' }]));
  assert.ok(pendingReadiness(commands, snapshot, [passed, { ...passed, phase: 'failed' }]));
  assert.ok(pendingReadiness(commands, snapshot, [{ ...passed, spec: { ...spec, args: [] } }]));
});

test('collecting readiness failures never skips a timeout or hides the latest rerun', t => {
  const f = fixture(t);
  const commands = normalizeGuidedPlan({
    ...f.plan,
    slices: [
      {
        ...f.plan.slices[0],
        readiness: [
          { kind: 'format', name: 'Format', file: 'node', args: ['--check', 'greeting.js'] },
          { kind: 'types', name: 'Types', file: 'node', args: ['--check', 'greeting.js'] },
        ],
      },
    ],
  }).slices[0]!.readiness;
  const snapshot = { artifact: 'sha256:current', instructionsDigest: 'current' };
  const first = pendingReadiness(commands, snapshot, [])!;
  const failed = {
    phase: 'failed',
    spec: first,
    before: snapshot,
    after: snapshot,
    error: null,
    result: { reason: 'exited', exitConfirmed: true, exitCode: 1, stdout: '', stderr: '', outputTruncated: false },
  } as RepositoryCheck;
  const second = pendingReadiness(commands, snapshot, [failed], true)!;
  assert.equal(second.name, 'Types');
  const timedOut = { ...failed, spec: second, result: { ...failed.result!, reason: 'timed_out' } };
  assert.deepEqual(pendingReadiness(commands, snapshot, [failed, timedOut], true), second);
  const passed = { ...timedOut, phase: 'passed' as const };
  assert.equal(pendingReadiness(commands, snapshot, [failed, timedOut, passed], true), null);
  assert.deepEqual(pendingReadiness(commands, snapshot, [failed, timedOut, passed]), first);
});
