// The subset of Orca CLI JSON that Grampus reads, validated at the boundary. Orca's clients and runtime
// update independently, so unknown fields are ignored and optional fields may be absent. Only fields
// Grampus acts on are declared.
import { z } from 'zod';

export const okEnvelopeSchema = z.object({ ok: z.literal(true), result: z.unknown() });
export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), data: z.unknown().optional() }),
});

export const runCreateSchema = z.object({
  run: z.object({ id: z.string(), coordinator_handle: z.string().nullable() }),
});

export const taskCreateSchema = z.object({ task: z.object({ id: z.string() }) });

export const gateCreateSchema = z.object({ gate: z.object({ id: z.string() }) });

const launchSelectionSchema = z.object({
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
});
export type LaunchSelection = z.infer<typeof launchSelectionSchema>;

/** A `worker-start` receipt. Orca exits non-zero for `failed` and `outcome_unknown` but still prints it. */
export const workerStartSchema = z.object({
  taskId: z.string(),
  dispatchId: z.string(),
  state: z.string(),
  workerOutcome: z.enum(['succeeded', 'failed']).optional(),
  lastError: z.string().nullable().optional(),
  failedStage: z.string().nullable().optional(),
  launch: z
    .object({
      requested: launchSelectionSchema.nullable().optional(),
      effective: launchSelectionSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type WorkerStartReceipt = z.infer<typeof workerStartSchema>;

export const messageSchema = z.object({
  id: z.string(),
  from_handle: z.string().nullable().optional(),
  subject: z.string(),
  body: z.string().nullable().optional(),
  type: z.string(),
  payload: z.string().nullable().optional(),
  created_at: z.string(),
});
export type OrcaMessage = z.infer<typeof messageSchema>;

/** The structured payload of lifecycle messages, built by Orca from `--task-id`, `--outcome` and so on. */
export const lifecyclePayloadSchema = z.object({
  taskId: z.string().optional(),
  dispatchId: z.string().optional(),
  outcome: z.enum(['succeeded', 'failed']).optional(),
  filesModified: z.array(z.string()).optional(),
  reportPath: z.string().optional(),
  phase: z.string().optional(),
});
export type LifecyclePayload = z.infer<typeof lifecyclePayloadSchema>;

export const checkSchema = z.object({
  deliveryId: z.string().nullable().optional(),
  messages: z.array(messageSchema),
});

/** `worker-show`. Unlike `run-create` and messages, its rows are camelCase. */
export const workerShowSchema = z.object({
  dispatch: z.object({ assigneeHandle: z.string().nullable().optional() }).nullable().optional(),
  worker: z.object({ agentTerminalHandle: z.string().nullable().optional() }).nullable().optional(),
  projection: z.object({ liveness: z.unknown().optional() }).nullable().optional(),
});

/** `worker-read --source transcript`: only the provider and message ids, which name provider sessions. */
export const workerReadSchema = z.object({
  provider: z.string().nullable().optional(),
  transcript: z
    .object({ messages: z.array(z.object({ id: z.string() })) })
    .nullable()
    .optional(),
});

export const worktreeSchema = z.object({
  worktree: z.object({ id: z.string(), path: z.string(), branch: z.string().nullable().optional() }),
});

export const terminalCreateSchema = z.object({ terminal: z.object({ handle: z.string() }) });

export const terminalListSchema = z.object({ terminals: z.array(z.object({ handle: z.string() })) });

/** `terminal show`: `title` is the tab's current title, which a shell overwrites; `paneTitle` keeps the one it was created with. */
export const terminalShowSchema = z.object({
  terminal: z.object({ handle: z.string(), title: z.string().optional(), paneTitle: z.string().optional() }),
});

/** `repo list`: the repositories registered in Orca. */
export const repoListSchema = z.object({
  repos: z.array(z.object({ id: z.string(), path: z.string(), displayName: z.string().optional() })),
});

export const statusSchema = z.object({
  runtime: z.object({ appVersion: z.string().optional(), reachable: z.boolean().optional() }).optional(),
});
