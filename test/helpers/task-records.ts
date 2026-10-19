// Schema-valid task and guided state records for tests that seed a journal directly. The store
// validates every task it reads, so a fixture must be a complete record, not just the fields a query uses.
import type { Task } from '../../src/domain/workflow.js';
import type { GuidedPlan } from '../../src/domain/guided-plan.js';
import type { GuidedState } from '../../src/orchestration/guided/state.js';

const command = { name: 'Fixture check', file: process.execPath, args: ['-e', ''], timeoutMs: 30_000 };

/** A minimal normalised plan for one no-change slice. It is never dispatched. */
export function planRecord(fields: Partial<GuidedPlan> = {}): GuidedPlan {
  return {
    workflowPolicy: { mode: 'automatic', repairRounds: 2, maxSessionTurns: 6, maxContextTokens: 120_000 },
    quality: { passes: [] },
    context: { files: [], inventoryDigest: 'fixture', totalFiles: 0, totalBytes: 0, exploration: true },
    brief: { title: 'Fixture', outcome: 'Fixture outcome', criteria: ['Fixture criterion'], plan: 'Fixture plan' },
    workspace: { repo: process.cwd(), base: '0'.repeat(40), adapter: 'git', path: process.cwd() },
    implementation: { provider: 'codex', model: null },
    review: { provider: 'claude', model: null },
    slices: [
      {
        scope: { files: [] },
        validation: command,
        acceptance: { ...command, expectedStdout: '' },
        message: 'Fixture delivery',
        mode: 'no_change',
      },
    ],
    ...fields,
  };
}

/** A guided state at the start of a fresh plan, with `fields` applied. */
export function guidedRecord(fields: Partial<GuidedState> = {}): GuidedState {
  return {
    implementationContinuation: null,
    reviewContinuation: null,
    retryAnchor: null,
    failedCheckId: null,
    repairCycle: { used: 0, failures: [] },
    reviewCycle: { repairs: 0, history: [], arbitrating: false, arbitrationUsed: false },
    version: 1,
    plan: planRecord(),
    digest: 'fixture',
    approvedDigest: null,
    status: 'draft',
    stage: 'workspace',
    sliceIndex: 0,
    workspaceId: null,
    executionId: null,
    reviewId: null,
    validationId: null,
    snapshot: null,
    policy: null,
    owner: null,
    pending: null,
    stopRequested: false,
    pauseRequested: false,
    guidance: [],
    assessments: [],
    qualityEdits: [],
    answers: null,
    feedback: '',
    note: '',
    stopReason: null,
    ...fields,
  };
}

/** A draft task record `id` with `fields` applied. */
export function taskRecord(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    brief: { title: 'Fixture', outcome: 'Fixture outcome', criteria: ['Fixture criterion'], plan: 'Fixture plan' },
    version: 1,
    approvedVersion: null,
    phase: 'draft',
    synthetic: false,
    attempt: null,
    evidence: [],
    decisions: [],
    ...fields,
  };
}
