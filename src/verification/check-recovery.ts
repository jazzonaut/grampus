// Owns supervisor receipts and the liveness proofs recovery depends on: allocating a receipt directory,
// reading a terminal completion receipt and deciding whether a recorded controller or supervisor is gone.
// It never kills processes or reruns anything; an unverifiable process is treated as alive.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../persistence/store.js';
import { commandLimits } from '../config/limits.js';
import type { ExecutionLease } from '../execution/execution-state.js';
import type { CheckProcessResult } from '../process/check-process.js';
import { inspectProcess, validProcessStartTime } from '../process/process-identity.js';
import { BoundaryError, describeIssues, parseJson, systemErrorCode } from '../process/boundary.js';
import { completionReceiptSchema, type CheckReceipt } from '../process/supervisor-protocol.js';

export type { CheckReceipt } from '../process/supervisor-protocol.js';
/**
 * Create a fresh receipt directory beside the journal (`<journal>.checks/run-*`, or the temporary folder
 * for an in-memory store) with a random token. The token and operation id bind the eventual completion
 * receipt to this one dispatch, so a receipt from another run is never adopted.
 */
export function allocateReceipt(store: Store, checkId: string): CheckReceipt {
  const root = store.path === ':memory:' ? tmpdir() : `${store.path}.checks`;
  mkdirSync(root, { recursive: true });
  return { directory: mkdtempSync(join(root, 'run-')), token: randomUUID(), checkId };
}

/**
 * Whether a recorded process may still be running. Errs towards alive: an invalid PID or start time, a
 * signal probe failing for any reason other than `ESRCH`, or an unknown observation all count as alive,
 * because recovery must never act on a guess. With a recorded start time a live PID only counts if its
 * creation time matches, so a recycled Windows PID is recognised as a different process.
 */
export function processAlive(pid: number, startedAt?: string | null): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || (startedAt != null && !validProcessStartTime(startedAt))) return true;
  try {
    // Signal 0 only probes existence; it sends nothing to the process.
    process.kill(pid, 0);
  } catch (error) {
    return systemErrorCode(error) !== 'ESRCH';
  }
  if (startedAt == null) return true; // An unobserved creation time still requires PID absence.
  const observed = inspectProcess(pid);
  return observed.state === 'unknown' || (observed.state === 'present' && observed.startedAt === startedAt);
}
/**
 * Recovery precondition: the lease's controller must have run on this host and be provably gone.
 *
 * @throws Error when the lease belongs to another host, or its controller is alive or unverifiable.
 */
export function requireDeadController(lease: ExecutionLease): void {
  if (lease.host !== hostname()) throw new Error('Recover this operation on its execution host');
  if (processAlive(lease.controllerPid, lease.controllerStartedAt))
    throw new Error('Previous controller is still alive or unverifiable');
}

/**
 * A matching terminal receipt proves job settlement; PID absence alone does not. The receipt must carry
 * this dispatch's operation id and token and, when they were recorded, the same supervisor and tool PIDs,
 * and the supervisor that wrote it must be gone. Output is not part of the receipt: callers read the
 * durable logs separately, so the returned result has empty previews.
 *
 * @throws Error when `completion.json` is missing or oversized, the receipt does not match, or the
 *   supervisor is still alive or unverifiable; `BoundaryError` when it is not a valid receipt.
 */
export function readReceipt(
  receipt: CheckReceipt,
  supervisorPid: number | null,
  toolPid: number | null,
): CheckProcessResult {
  const path = join(receipt.directory, 'completion.json');
  if (statSync(path).size > commandLimits.protocolBytes) throw new Error('Invalid supervisor completion receipt');
  const context = { kind: 'supervisor-receipt', source: 'completion.json' } as const;
  const parsed = completionReceiptSchema.safeParse(parseJson(readFileSync(path, 'utf8'), context));
  if (!parsed.success)
    throw new BoundaryError(
      context,
      describeIssues(parsed.error),
      'Supervisor completion receipt does not match this check',
      { cause: parsed.error },
    );
  const value = parsed.data;
  if (
    value.checkId !== receipt.checkId ||
    value.token !== receipt.token ||
    (supervisorPid !== null && value.supervisorPid !== supervisorPid) ||
    (toolPid !== null && value.toolPid !== toolPid)
  ) {
    throw new Error('Supervisor completion receipt does not match this check');
  }
  if (processAlive(value.supervisorPid, value.supervisorStartedAt))
    throw new Error('Supervisor is still alive or unverifiable');
  return {
    reason: value.reason,
    exitCode: value.exitCode,
    exitConfirmed: true,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    ...(value.elapsedMs === null ? {} : { elapsedMs: value.elapsedMs }),
  };
}
