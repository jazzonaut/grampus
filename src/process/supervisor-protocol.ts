// Pins the contracts of the Windows check supervisor (native/check.cs, run through check.ps1 by the
// detached check host) and of the process identity helper (native/process.ps1):
//
// - `supervisorMessageSchema`: each stdout line of the supervisor, `started` then one `result`. Any other
//   line is a protocol failure: the controller kills the supervisor and records `supervisor_lost`, so the
//   outcome stays unknown rather than guessed.
// - `checkHostRequestSchema`: the single request line the host forwards. A malformed request stops the
//   host before any tool starts.
// - `completionReceiptSchema`: the flushed `completion.json` receipt that recovery uses as proof that the
//   job settled. A receipt that does not match is a `BoundaryError` (`supervisor-receipt`); recovery then
//   stays blocked. Matching it against the expected check, token and process ids is check-recovery.ts.
// - `processObservationSchema`: process.ps1 output. Anything else is an unknown observation, which never
//   proves a process absent.
import { z } from 'zod';

/** A Windows FILETIME creation time as decimal text; it is never rounded through a JS number. */
export function validProcessStartTime(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
}

const pid = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const startTime = z.string().refine(validProcessStartTime, 'Invalid process creation time');

export const supervisorMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), pid }),
  z.object({
    type: z.literal('result'),
    reason: z.string(),
    exitCode: z.number().int(),
    exitConfirmed: z.boolean(),
  }),
]);
export type SupervisorMessage = z.infer<typeof supervisorMessageSchema>;

/** The host reads only the deadline; the rest of the request is forwarded to the supervisor unchanged. */
export const checkHostRequestSchema = z.looseObject({ timeoutMs: z.number() });

/** Where a supervised run writes its receipt, and the token and id the receipt must repeat. */
export const checkReceiptSchema = z.object({ directory: z.string(), token: z.string(), checkId: z.string() });
export type CheckReceipt = z.infer<typeof checkReceiptSchema>;

/** Terminal reasons the supervisor may record in a receipt. */
export const receiptReasons = [
  'exited',
  'interrupted',
  'timed_out',
  'output_limit',
  'descendants_remaining',
  'supervisor_error',
] as const;

export const completionReceiptSchema = z.object({
  protocol: z.literal(1),
  checkId: z.string(),
  token: z.string(),
  exitConfirmed: z.literal(true),
  supervisorPid: pid,
  supervisorStartedAt: startTime.nullish(),
  toolPid: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  exitCode: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.enum(receiptReasons),
});
export type CompletionReceipt = z.infer<typeof completionReceiptSchema>;

export const processObservationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('present'), startedAt: startTime }),
  z.object({ state: z.literal('absent') }),
  z.object({ state: z.literal('unknown') }),
]);
