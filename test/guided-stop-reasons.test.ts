// Fast unit tests for guided stop reasons and structural equality: check and review settlement run
// against in-memory stubs, so every code is pinned without Git, providers or a journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual } from '../src/domain/deep-equal.js';
import type { SettleContext, StageOutcome } from '../src/orchestration/guided/context.js';
import type { GuidedState } from '../src/orchestration/guided/state.js';
import { repairIneligibility, validationStage } from '../src/orchestration/guided/stages/checks.js';
import { reviewStage } from '../src/orchestration/guided/stages/review.js';
import {
  GuidedStopError,
  StopReasonCode,
  errorReasonCode,
  withReason,
} from '../src/orchestration/guided/stop-reasons.js';
import type { RepositoryCheck } from '../src/verification/checks.js';
import type { Reply } from '../src/providers/types.js';

const controller = { token: 'token', controllerPid: 1, controllerStartedAt: null, host: 'host' };
const validation = { name: 'Validation', file: 'node', args: ['-e', ''], timeoutMs: 1000 };
const artifact = 'sha256:current';

function guided(mode: 'automatic' | 'supervised', overrides: Record<string, unknown> = {}): GuidedState {
  return {
    plan: {
      workflowPolicy: { mode, repairRounds: 2 },
      implementation: { provider: 'codex', model: null },
      review: { provider: 'claude', model: null },
      slices: [{ mode: 'commit', scope: { files: ['a.js'] }, validation, acceptance: validation, message: 'Deliver' }],
    },
    sliceIndex: 0,
    stage: 'validation',
    status: 'running',
    snapshot: { artifact, instructionsDigest: 'instructions' },
    executionId: 'execution',
    reviewId: 'review',
    repairCycle: { used: 0, failures: [] },
    reviewCycle: { repairs: 0, history: [], arbitrating: false, arbitrationUsed: false },
    ...overrides,
  } as unknown as GuidedState;
}

function failedCheck(overrides: Partial<RepositoryCheck> = {}, result: Record<string, unknown> = {}): RepositoryCheck {
  return {
    id: 'check',
    executionId: 'execution',
    phase: 'failed',
    spec: { ...validation, artifact, instructionsDigest: 'instructions' },
    before: { artifact },
    after: { artifact },
    result: {
      reason: 'exited',
      exitCode: 1,
      exitConfirmed: true,
      stdout: '',
      stderr: 'AssertionError: expected greeting',
      outputTruncated: false,
      ...result,
    },
    error: null,
    purpose: 'validation',
    dispatch: 'requested',
    supervisorPid: null,
    toolPid: null,
    ...overrides,
  } as RepositoryCheck;
}

interface Recorded {
  changes: { type: string; state: GuidedState }[];
  retries: string[];
  closed: string[];
}

/** A settlement context over plain objects; `change` applies updates to a copy and records them. */
function context(state: GuidedState, stage: string, stores: Record<string, unknown>, recorded: Recorded) {
  const lease = (runId: string) => [
    { type: 'lease.acquired', data: { runId, controllerPid: 1, controllerStartedAt: null, host: 'host' } },
  ];
  return {
    id: 'task',
    token: 'token',
    state,
    pending: { stage, known: [], assessment: null, controller },
    snapshot: null,
    recovering: false,
    services: {},
    workspaces: {},
    checks: {},
    store: {
      transaction: (action: () => unknown) => action(),
      executionEvents: () => lease(stage === 'review' ? 'turn' : 'check'),
      ...stores,
    },
    workflow: { get: () => ({ evidence: stores['evidence'] ?? [] }) },
    executions: {
      get: (id: string) => ({ id, sessionId: 'session', artifact }),
      close: (id: string) => recorded.closed.push(id),
    },
    change: (type: string, update: (state: GuidedState) => void) => {
      const next = structuredClone(state);
      update(next);
      recorded.changes.push({ type, state: next });
      return next;
    },
    prepareRetry: (type: string) => recorded.retries.push(type),
  } as unknown as SettleContext;
}

const record = (): Recorded => ({ changes: [], retries: [], closed: [] });

function settleValidation(state: GuidedState, check: RepositoryCheck, recorded = record()): StageOutcome {
  return validationStage.settle(context(state, 'validation', { checks: () => [check] }, recorded));
}

function stopCode(outcome: StageOutcome): string | null {
  return outcome.kind === 'stop' || outcome.kind === 'wait' ? outcome.reason.code : null;
}

test('every stop reason code equals its key, so codes are stable journal values', () => {
  for (const [key, value] of Object.entries(StopReasonCode)) assert.equal(value, key);
});

test('repair eligibility names the specific reason a failed check cannot be repaired', () => {
  const automatic = guided('automatic');
  const cases: [RepositoryCheck, GuidedState, string | null][] = [
    [failedCheck(), automatic, null],
    [failedCheck({ phase: 'interrupted' }), automatic, 'CHECK_INTERRUPTED'],
    [failedCheck({}, { reason: 'timed_out' }), automatic, 'CHECK_TIMEOUT'],
    [failedCheck({}, { reason: 'output_limit' }), automatic, 'CHECK_OUTPUT_LIMIT'],
    [failedCheck({}, { reason: 'supervisor_lost' }), automatic, 'CHECK_EXIT_UNCONFIRMED'],
    [failedCheck({}, { exitConfirmed: false }), automatic, 'CHECK_EXIT_UNCONFIRMED'],
    [failedCheck({ result: null }), automatic, 'CHECK_EXIT_UNCONFIRMED'],
    [failedCheck({}, { outputUnavailable: true }), automatic, 'CHECK_OUTPUT_UNAVAILABLE'],
    [failedCheck({ error: 'Check changed repository inputs' }), automatic, 'CHECK_ERROR'],
    [failedCheck({ error: 'stdout differs', failureKind: 'acceptance' }), automatic, null],
    [
      failedCheck({ error: 'stdout differs', failureKind: 'acceptance' }, { outputTruncated: true }),
      automatic,
      'CHECK_OUTPUT_TRUNCATED',
    ],
    [
      failedCheck({ after: { artifact: 'sha256:other' } } as Partial<RepositoryCheck>),
      automatic,
      'CHECK_MUTATED_ARTIFACT',
    ],
    [
      failedCheck({
        before: { artifact: 'sha256:old' },
        after: { artifact: 'sha256:old' },
      } as Partial<RepositoryCheck>),
      automatic,
      'CHECK_STALE_ARTIFACT',
    ],
    [
      failedCheck(),
      guided('automatic', {
        plan: { ...automatic.plan, slices: [{ ...automatic.plan.slices[0]!, mode: 'no_change' }] },
      }),
      'CHECK_FAILED_NO_CHANGE',
    ],
    [failedCheck(), guided('supervised'), 'CHECK_FAILED_SUPERVISED'],
  ];
  for (const [check, state, expected] of cases) assert.equal(repairIneligibility(state, check), expected);
});

test('a failed check spends the repair allowance, then stops as exhausted or without progress', () => {
  const recorded = record();
  const repair = settleValidation(guided('automatic'), failedCheck(), recorded);
  assert.deepEqual(repair, { kind: 'rerouted', to: 'repair' });
  assert.deepEqual(
    recorded.changes.map(change => change.type),
    ['guided.check_failed', 'guided.repair_budget_used'],
  );
  assert.deepEqual(recorded.retries, ['guided.validation_repair_requested']);
  assert.equal(recorded.changes[1]!.state.repairCycle.used, 1);

  const exhausted = settleValidation(guided('automatic', { repairCycle: { used: 2, failures: [] } }), failedCheck());
  assert.equal(stopCode(exhausted), 'CHECK_REPAIR_EXHAUSTED');
  assert.match((exhausted as { reason: { note: string } }).reason.note, /allowance exhausted \(2\/2\)/);

  const repeated = guided('automatic', {
    repairCycle: { used: 1, failures: [{ purpose: 'validation', artifact, issue: 'same' }] },
  });
  assert.equal(stopCode(settleValidation(repeated, failedCheck())), 'CHECK_NO_PROGRESS');
  assert.equal(stopCode(settleValidation(guided('supervised'), failedCheck())), 'CHECK_FAILED_SUPERVISED');
});

function settleReview(state: GuidedState, reply: Partial<Reply>, outcome: string, phase = 'idle', recorded = record()) {
  const session = {
    id: 'session',
    phase,
    run: null,
    lastReply: { kind: 'review', text: 'Review text', questions: [], findings: [], ...reply },
  };
  return reviewStage.settle(
    context(
      { ...state, stage: 'review' },
      'review',
      {
        session: () => session,
        sessionEvents: () => [{ type: 'turn.requested', data: { runId: 'turn' } }],
        evidence: [{ kind: 'review', id: 'turn', outcome }],
      },
      recorded,
    ),
  );
}

const blocking: Partial<Reply> = {
  findings: [{ severity: 'blocking', description: 'Defect', evidence: 'Concrete' }],
};

test('review settlement records why a verdict stops and when it reroutes', () => {
  const automatic = guided('automatic');
  assert.equal(stopCode(settleReview(automatic, {}, 'passed')), 'REVIEW_MISSING_SIMPLIFICATION');
  const passed = settleReview(automatic, { simplification: { outcome: 'passed', summary: 'Simple' } }, 'passed');
  assert.equal(passed.kind === 'advance' && passed.next, 'assessment');
  assert.equal(stopCode(settleReview(automatic, {}, 'failed')), 'REVIEW_FAILED_NO_BLOCKING_FINDINGS');
  assert.equal(stopCode(settleReview(automatic, blocking, 'failed', 'failed')), 'REVIEW_TURN_FAILED');
  assert.equal(stopCode(settleReview(automatic, {}, 'passed', 'awaiting_answer')), 'AGENT_QUESTION');

  const recorded = record();
  assert.deepEqual(settleReview(automatic, blocking, 'failed', 'idle', recorded), { kind: 'rerouted', to: 'repair' });
  assert.equal(recorded.changes[0]!.type, 'guided.blocking_review');
  assert.equal(recorded.changes[0]!.state.stopReason?.code, 'REVIEW_BLOCKING_FINDINGS');
  assert.deepEqual(recorded.retries, ['guided.review_repair_requested']);

  const exhausted = guided('automatic', {
    reviewCycle: { repairs: 2, history: [], arbitrating: false, arbitrationUsed: false },
  });
  assert.equal(stopCode(settleReview(exhausted, blocking, 'failed')), 'REVIEW_REPAIR_EXHAUSTED');
  const repeated = guided('automatic', {
    reviewCycle: {
      repairs: 0,
      history: [{ executionId: 'old', artifact }],
      arbitrating: false,
      arbitrationUsed: false,
    },
  });
  assert.equal(stopCode(settleReview(repeated, blocking, 'failed')), 'REVIEW_NO_PROGRESS');
  const arbitrating = guided('automatic', {
    reviewCycle: { repairs: 0, history: [], arbitrating: true, arbitrationUsed: true },
  });
  assert.equal(stopCode(settleReview(arbitrating, blocking, 'failed')), 'ARBITRATION_UNRESOLVED');

  const arbitrated = record();
  const withArbitrator = guided('automatic', {
    plan: { ...automatic.plan, reviewPolicy: { repairRounds: 0, arbitrator: { provider: 'codex', model: null } } },
  });
  assert.deepEqual(settleReview(withArbitrator, blocking, 'failed', 'idle', arbitrated), {
    kind: 'rerouted',
    to: 'arbitration',
  });
  assert.deepEqual(arbitrated.closed, ['review']);
  assert.equal(arbitrated.changes.at(-1)!.type, 'guided.arbitration_requested');
  assert.equal(arbitrated.changes.at(-1)!.state.reviewCycle.arbitrating, true);
});

test('coded errors keep their message and cause; other errors fall back to the generic code', () => {
  const plain = new Error('Editing changed Git state');
  assert.throws(
    () =>
      withReason('SCOPE_REJECTED', () => {
        throw plain;
      }),
    (error: unknown) =>
      error instanceof GuidedStopError &&
      error.code === 'SCOPE_REJECTED' &&
      error.message === plain.message &&
      error.cause === plain,
  );
  assert.equal(
    errorReasonCode(new GuidedStopError('RESULT_MISMATCH', 'differs'), 'UNEXPECTED_ERROR'),
    'RESULT_MISMATCH',
  );
  assert.equal(errorReasonCode(plain, 'UNEXPECTED_ERROR'), 'UNEXPECTED_ERROR');
  assert.equal(
    withReason('SCOPE_REJECTED', () => 'value'),
    'value',
  );
});

test('structural equality ignores key order and undefined properties, as the journal does', () => {
  assert.ok(deepEqual({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 }));
  assert.ok(deepEqual({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
  assert.ok(!deepEqual([1, 2], [2, 1]));
  assert.ok(!deepEqual({ a: [] }, { a: {} }));
  assert.ok(!deepEqual(null, {}));
  assert.ok(!deepEqual({ a: null }, { a: undefined }));
  assert.ok(deepEqual(null, null));
});
