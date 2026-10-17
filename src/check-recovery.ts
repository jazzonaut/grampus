import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import type { ExecutionLease } from './execution-state.js';
import type { CheckProcessResult } from './check-process.js';

export interface CheckReceipt { directory: string; token: string; checkId: string }
export function allocateReceipt(store: Store, checkId: string): CheckReceipt {
  const root = store.path === ':memory:' ? tmpdir() : `${store.path}.checks`;
  mkdirSync(root, { recursive: true });
  return { directory: mkdtempSync(join(root, 'run-')), token: randomUUID(), checkId };
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function requireDeadController(lease: ExecutionLease): void {
  if (lease.host !== hostname()) throw new Error('Recover this operation on its execution host');
  if (processAlive(lease.controllerPid)) throw new Error('Previous controller is still alive or unverifiable');
}

/** A matching terminal receipt proves job settlement; PID absence alone does not. */
export function readReceipt(receipt: CheckReceipt, supervisorPid: number | null, toolPid: number | null): CheckProcessResult {
  const path = join(receipt.directory, 'completion.json');
  if (statSync(path).size > 4096) throw new Error('Invalid supervisor completion receipt');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (value.protocol !== 1 || value.checkId !== receipt.checkId || value.token !== receipt.token || value.exitConfirmed !== true
    || !Number.isSafeInteger(value.supervisorPid) || (value.supervisorPid as number) < 1
    || !Number.isSafeInteger(value.toolPid) || (value.toolPid as number) < 0
    || !Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0
    || !['exited', 'interrupted', 'timed_out', 'output_limit', 'descendants_remaining', 'supervisor_error'].includes(value.reason as string)
    || (supervisorPid !== null && value.supervisorPid !== supervisorPid) || (toolPid !== null && value.toolPid !== toolPid)) {
    throw new Error('Supervisor completion receipt does not match this check');
  }
  if (processAlive(value.supervisorPid as number)) throw new Error('Supervisor is still alive or unverifiable');
  return { reason: value.reason as string, exitCode: value.exitCode as number, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
}
