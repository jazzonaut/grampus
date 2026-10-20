// Pins the journal record contracts: the task record (composed from the task fields owned by
// domain/workflow.ts and the guided state owned by orchestration/guided/state.ts) and the tables owned
// by the execution layer: sessions, executions, execution leases, workspaces, checks, implementation
// runs and deliveries. `Store` validates every row it reads against these schemas, so a record that
// does not match (a corrupted file, or a bug that wrote the wrong shape) is a `BoundaryError` of kind
// `journal-record` naming the table and fields, not an undefined property discovered later. Validation
// is in place: the stored object is returned unchanged, because fences and digests compare these
// records by their serialised bytes.
import { reasoningEffortSchema } from '../domain/model-profiles.js';
import { z } from 'zod';
import { providerSchema } from '../providers/types.js';
import { providerRuntimeSchema } from '../providers/executables.js';
import { agentReplySchema, turnResultSchema } from '../providers/reply-schema.js';
import { repositorySnapshotSchema } from '../repository/snapshot-schema.js';
import { checkProcessResultSchema } from '../process/check-process.js';
import { checkReceiptSchema } from '../process/supervisor-protocol.js';
import { editPolicySchema } from '../execution/edit-policy.js';
import { acceptanceExpectationsSchema } from '../domain/acceptance.js';
import { taskFieldsSchema, type Task } from '../domain/workflow.js';
import { guidedStateSchema } from '../orchestration/guided/state.js';

/**
 * A stored task with its guided state. Composed here rather than in domain/workflow.ts because the
 * guided plan schema depends on that module, and a schema cannot be built from a module that has not
 * finished loading.
 */
export const taskSchema = taskFieldsSchema.extend({ guided: guidedStateSchema.exactOptional() }) satisfies z.ZodType<
  Task,
  Task
>;

const pid = z.number();
/** Null when a creation time could not be observed; recovery then stays conservative. */
const startedAt = z.string().nullable();
/**
 * The no-replay boundary of a process or provider connection. `requested` is saved before it may
 * start, so after a crash recovery must reconcile what happened (from the supervisor's settlement
 * receipt for a check, implementation run or delivery) and never starts it again.
 */
const dispatch = z.enum(['not_requested', 'requested']);

export const sessionSchema = z.object({
  /** The agent toolset the conversation was given; a Codex session with an older one starts fresh. */
  toolsetVersion: z.number().exactOptional(),
  deletedAt: z.string().exactOptional(),
  mode: z.literal('editing').exactOptional(),
  id: z.string(),
  provider: providerSchema,
  /** The provider executable, its version and the pinned SDK version when the session was created. */
  runtime: providerRuntimeSchema,
  providerSessionId: z.string().nullable(),
  model: z.string().nullable(),
  requestedModel: z.string().nullable(),
  effort: reasoningEffortSchema.exactOptional(),
  cwd: z.string(),
  phase: z.enum(['idle', 'running', 'awaiting_answer', 'stop_requested', 'interrupted', 'failed', 'recovery_required']),
  lastReply: agentReplySchema.nullable(),
  run: z
    .object({
      id: z.string(),
      controllerPid: pid,
      host: z.string(),
      providerPid: pid.nullable(),
      controllerStartedAt: startedAt,
      providerStartedAt: startedAt,
      /** Tracked only for runs whose provider connection is a separate durable step. */
      providerDispatch: dispatch.exactOptional(),
    })
    .nullable(),
});
/** An agent conversation: provider identity, phase, last validated reply and the active run's owners. */
export type Session = z.infer<typeof sessionSchema>;

/**
 * Why an execution exists, fixed when it is created so usage can be attributed without inference:
 * the first implementation of a slice, a later implementation attempt in the same slice (`repair`,
 * covering automatic repairs and explicit retries), an independent review, or a fresh arbitration.
 */
export const executionStageSchema = z.enum(['implementation', 'repair', 'review', 'arbitration']);
export type ExecutionStage = z.infer<typeof executionStageSchema>;

/**
 * The workflow stage one provider turn belongs to, recorded on its `turn.requested` session event.
 * Turns of an execution take its {@link ExecutionStage}, except edit quality passes, which run in the
 * implementation conversation but are their own stage; turns outside any execution are planning.
 */
export const turnStageSchema = z.enum(['planning', 'quality_pass', ...executionStageSchema.options]);
export type TurnStage = z.infer<typeof turnStageSchema>;

export const executionSchema = z.object({
  stage: executionStageSchema,
  sliceIndex: z.number(),
  id: z.string(),
  taskId: z.string(),
  version: z.number(),
  attemptId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  role: z.enum(['implementation', 'review']),
  phase: z.enum(['open', 'closed']),
  headAtCreation: z.string(),
  artifact: z.string().nullable(),
  fallbackReason: z.string().nullable(),
});
/** An immutable binding of one task attempt to a workspace and a fresh session in a role. */
export type Execution = z.infer<typeof executionSchema>;

export const executionLeaseSchema = z.object({
  executionId: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  controllerPid: pid,
  controllerStartedAt: startedAt,
  host: z.string(),
  kind: z.enum([
    'conversation',
    'snapshot',
    'check',
    'submission',
    'assessment',
    'verification',
    'completion',
    'delivery',
    'implementation',
  ]),
  /**
   * Set for operations that never dispatch a repository-writing tool (snapshot, submission, assessment,
   * completion), whose lease may be released once the controller is proven dead.
   */
  readOnlyRecovery: z.literal(true).exactOptional(),
});
/** The single current owner of a workspace, held until process exit is confirmed. */
export type ExecutionLease = z.infer<typeof executionLeaseSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  version: z.number(),
  adapter: z.enum(['git', 'orca']),
  repository: z.string(),
  commonDirectory: z.string(),
  path: z.string().nullable(),
  branch: z.string().nullable(),
  baseCommit: z.string(),
  host: z.string(),
  phase: z.enum(['creating', 'ready', 'recovery_required', 'released']),
  owner: z
    .object({
      controllerPid: pid,
      gitPid: pid.nullable(),
      exitConfirmed: z.boolean(),
      controllerStartedAt: startedAt,
      gitStartedAt: startedAt,
    })
    .nullable(),
  orca: z
    .object({
      repoId: z.string(),
      name: z.string(),
      marker: z.string(),
      identityKey: z.string().nullable(),
      instanceId: z.string().nullable(),
      worktreeId: z.string().nullable(),
    })
    .exactOptional(),
});
/** A worktree reservation, its identity and its creation owner. */
export type Workspace = z.infer<typeof workspaceSchema>;

export const checkSpecSchema = z.object({
  name: z.string(),
  file: z.string(),
  args: z.array(z.string()),
  timeoutMs: z.number(),
  artifact: z.string(),
  instructionsDigest: z.string(),
  criteria: z.array(z.string()).exactOptional(),
  expectedStdout: z.string().exactOptional(),
  expectations: acceptanceExpectationsSchema.exactOptional(),
  preparation: z
    .object({ scope: editPolicySchema.pick({ files: true, create: true, delete: true }).exactOptional() })
    .exactOptional(),
});
/** An approved command with literal arguments, bound to the artifact and instructions it checks. */
export type CheckSpec = z.infer<typeof checkSpecSchema>;

export const repositoryCheckSchema = z.object({
  /** Set when a verification ran but its output did not meet the approved acceptance observations. */
  failureKind: z.literal('acceptance').exactOptional(),
  id: z.string(),
  executionId: z.string(),
  phase: z.enum(['running', 'passed', 'failed', 'interrupted', 'recovery_required']),
  spec: checkSpecSchema,
  before: repositorySnapshotSchema.nullable(),
  after: repositorySnapshotSchema.nullable(),
  supervisorPid: pid.nullable(),
  toolPid: pid.nullable(),
  result: checkProcessResultSchema.nullable(),
  error: z.string().nullable(),
  purpose: z.enum(['validation', 'verification', 'preparation']),
  dispatch,
  /** Allocated just before dispatch; absent when the check stopped first. */
  receipt: checkReceiptSchema.exactOptional(),
});
/** One supervised check: request, snapshots, process identities and result. */
export type RepositoryCheck = z.infer<typeof repositoryCheckSchema>;

export const implementationRunSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  policy: editPolicySchema,
  phase: z.enum(['running', 'completed', 'failed', 'interrupted', 'recovery_required']),
  dispatch,
  before: repositorySnapshotSchema.nullable(),
  after: repositorySnapshotSchema.nullable(),
  receipt: checkReceiptSchema.nullable(),
  supervisorPid: pid.nullable(),
  toolPid: pid.nullable(),
  process: checkProcessResultSchema.nullable(),
  result: turnResultSchema.nullable(),
  error: z.string().nullable(),
});
/** One supervised native editing turn: policy, dispatch boundary, process proof and snapshots. */
export type ImplementationRun = z.infer<typeof implementationRunSchema>;

const deliveryMode = z.enum(['commit', 'no_change']);

export const deliverySpecSchema = z.object({
  artifact: z.string(),
  instructionsDigest: z.string(),
  message: z.string(),
  timeoutMs: z.number(),
  mode: deliveryMode.exactOptional(),
});
/** What the caller asks to deliver: the checked artifact, a commit message and a deadline. */
export type DeliverySpec = z.infer<typeof deliverySpecSchema>;

export const deliveryRequestSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  branch: z.string(),
  base: z.string(),
  message: z.string(),
  snapshot: repositorySnapshotSchema,
  mode: deliveryMode.exactOptional(),
  orca: z
    .object({ database: z.string(), executionId: z.string(), workspaceId: z.string(), identityKey: z.string() })
    .exactOptional(),
});
/** The exact request the supervised delivery worker executes; also its request file. */
export type DeliveryRequest = z.infer<typeof deliveryRequestSchema>;

export const deliverySchema = z.object({
  id: z.string(),
  executionId: z.string(),
  spec: deliverySpecSchema,
  phase: z.enum(['running', 'delivered', 'failed', 'interrupted', 'recovery_required']),
  dispatch,
  request: deliveryRequestSchema.nullable(),
  receipt: checkReceiptSchema.nullable(),
  supervisorPid: pid.nullable(),
  toolPid: pid.nullable(),
  result: checkProcessResultSchema.nullable(),
  commit: z.string().nullable(),
  error: z.string().nullable(),
  /** Set at settlement; null until then and for undelivered results. */
  outcome: z.enum(['committed', 'no_change']).nullable(),
});
/** One local commit delivery: checked snapshot, commit request, dispatch boundary and accepted commit. */
export type Delivery = z.infer<typeof deliverySchema>;
