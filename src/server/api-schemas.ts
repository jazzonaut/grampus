// Pins the dashboard API: one request body schema per route, and the request the server hands to an
// action worker. Bodies come from a browser and are proposals, never trusted state. A body that fails its
// schema is answered with 400 and field-level issues before any controller code runs. Unknown fields are
// ignored, because the browser posts whole forms; only the fields a route reads are typed and passed on.
// Plan bodies stay `unknown` here: plan normalisation is owned by domain/guided-plan.ts.
import { z } from 'zod';
import { providerSchema } from '../providers/types.js';
import { guidanceTargetSchema } from '../orchestration/guided/guidance.js';

const text = z.string();
/** The decision key, turn key or digest of the state the user inspected. */
const expected = z.string({ error: 'Send the decision key of the state you inspected' });
const answers = z.record(z.string(), z.string());
/** A field another module validates (file selections, reference folders, plans); it must be present. */
const delegated = (what: string) => z.unknown().refine(value => value !== undefined, { error: `${what} is required` });

export const suggestReferencesBody = z.object({ request: text.exactOptional() });
export const inspectRepositoryBody = z.object({
  repo: text,
  request: text.exactOptional(),
  contextFiles: z.unknown().exactOptional(),
  base: text.exactOptional(),
});
export const searchFilesBody = z.object({
  repo: text,
  base: text,
  query: text.exactOptional(),
  offset: z.number().int().min(0).exactOptional(),
});
export const createKickoffBody = z.object({
  repo: text,
  request: text,
  provider: providerSchema.exactOptional(),
  adapter: z.enum(['git', 'orca']).exactOptional(),
  path: text.exactOptional(),
  contextFiles: z.unknown().exactOptional(),
  base: text.exactOptional(),
  references: z.unknown().exactOptional(),
});
export const createTaskBody = z.object({ plan: delegated('plan') });
export const lifecycleBody = z.object({ expected });
export const kickoffContextBody = z.object({ files: delegated('files'), expected });
export const kickoffReferencesBody = z.object({ references: delegated('references'), expected });
export const prepareKickoffBody = z.object({
  digest: z.string({ error: 'Preparing approval requires the displayed proposal digest' }),
});
export const approveTaskBody = z.object({ expected, version: z.number().int().min(1), digest: text });
export const decisionBody = z.object({ expected });
export const queueGuidanceBody = z.object({ expected, text: z.string(), target: guidanceTargetSchema });
export const cancelGuidanceBody = z.object({ expected, messageId: z.string().min(1) });
/** `expected` is the revision of `config.json` the form was shown with; `overrides` is checked by config/settings.ts. */
export const saveSettingsBody = z.object({
  expected: z.string({ error: 'Send the settings revision you edited' }),
  overrides: delegated('overrides'),
});

/** Payloads of the actions that run in a worker, by action. Each carries the key it was decided on. */
export const workerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), payload: decisionBody }),
  z.object({ action: z.literal('authorize'), payload: decisionBody }),
  z.object({
    action: z.literal('assess'),
    payload: z.object({ expected, outcome: z.enum(['passed', 'failed', 'skipped']), summary: text }),
  }),
  z.object({ action: z.literal('answer'), payload: z.object({ expected, answers }) }),
  z.object({ action: z.literal('retry'), payload: decisionBody }),
  /** `expected` is the decision key of the stopped check; it also names the rerun it authorises. */
  z.object({ action: z.literal('rerun-checks'), payload: decisionBody }),
  z.object({ action: z.literal('revise'), payload: z.object({ expected, plan: delegated('plan') }) }),
  z.object({ action: z.literal('recover'), payload: decisionBody }),
  z.object({ action: z.literal('release-workspace'), payload: decisionBody }),
  z.object({
    action: z.literal('plan'),
    payload: z.object({ expected, message: text.exactOptional(), answers: answers.exactOptional() }),
  }),
  z.object({ action: z.literal('planner-recover'), payload: z.object({ expected: expected.exactOptional() }) }),
]);
export type WorkerAction = z.infer<typeof workerActionSchema>;
export type WorkerActionName = WorkerAction['action'];

/** Task actions the server hands to a worker. */
export const taskWorkerActions = [
  'run',
  'authorize',
  'assess',
  'answer',
  'retry',
  'rerun-checks',
  'revise',
  'recover',
  'release-workspace',
] as const satisfies readonly WorkerActionName[];

/**
 * The single JSON line the dashboard writes to an action worker's stdin. Settings are the server's
 * already validated settings and are parsed again by `parseSettings`.
 */
export const workerRequestSchema = z.intersection(
  /** `health`: the dashboard runs real integration checks, so a run worker checks stale health first. */
  z.object({ db: text, id: text, settings: z.unknown(), health: z.literal(true).exactOptional() }),
  workerActionSchema,
);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

/**
 * The last stderr line of a failed action worker: the message and, when the controller raised a typed
 * stop, its reason code. Anything else on stderr (runtime warnings, a crash trace) is kept as plain text.
 */
export const workerFailureSchema = z.object({ error: text, reasonCode: text.nullable() });
export type WorkerFailure = z.infer<typeof workerFailureSchema>;
