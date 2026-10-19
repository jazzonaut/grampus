import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { CheckReceipt } from '../verification/check-recovery.js';
import { z } from 'zod';
import { commandLimits, processLimits } from '../config/limits.js';
import { supervisorMessageSchema } from './supervisor-protocol.js';

/**
 * How a supervised process ended, with bounded output previews. It is recorded in check, implementation
 * and delivery journal records, which validate it with this schema when they are read back.
 */
export const checkProcessResultSchema = z.object({
  reason: z.string(),
  exitCode: z.number().nullable(),
  exitConfirmed: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
  outputUnavailable: z.boolean().exactOptional(),
  /** How long the supervised tool ran, as the supervisor measured it; absent when unknown. */
  elapsedMs: z.number().exactOptional(),
});
export type CheckProcessResult = z.infer<typeof checkProcessResultSchema>;
export interface CheckProcessOptions {
  /** Zero disables the runtime deadline for agent workers. */
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  started: (kind: 'supervisor' | 'tool', pid: number) => void;
  receipt?: CheckReceipt;
}

function output(path: string): { text: string; truncated: boolean; available: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', truncated: false, available: false };
  }
  try {
    const buffer = Buffer.alloc(commandLimits.previewBytes);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, count).toString('utf8'),
      truncated: statSync(path).size > count,
      available: true,
    };
  } finally {
    closeSync(fd);
  }
}

export function retainedOutput(
  directory: string,
): Pick<CheckProcessResult, 'stdout' | 'stderr' | 'outputTruncated' | 'outputUnavailable'> {
  const out = output(join(directory, 'stdout'));
  const err = output(join(directory, 'stderr'));
  return {
    stdout: out.text,
    stderr: err.text,
    outputTruncated: out.truncated || err.truncated,
    outputUnavailable: !out.available || !err.available,
  };
}

/** Windows job supervision is deliberately separate from provider conversation processes. */
export async function runCheckProcess(options: CheckProcessOptions): Promise<CheckProcessResult> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    (options.timeoutMs !== 0 &&
      (options.timeoutMs < commandLimits.minTimeoutMs || options.timeoutMs > commandLimits.maxTimeoutMs))
  )
    throw new Error('Invalid supervised process timeout');
  if (process.platform !== 'win32') throw new Error('Repository checks currently require Windows 10 or later');
  if (options.signal?.aborted)
    return {
      reason: 'interrupted',
      exitCode: null,
      exitConfirmed: true,
      stdout: '',
      stderr: '',
      outputTruncated: false,
    };
  const directory = options.receipt?.directory ?? mkdtempSync(join(tmpdir(), 'grampus-check-'));
  const stdout = join(directory, 'stdout');
  const stderr = join(directory, 'stderr');
  const host = fileURLToPath(new URL('./check-host.js', import.meta.url));
  let result: CheckProcessResult = {
    reason: 'supervisor_lost',
    exitCode: null,
    exitConfirmed: false,
    stdout: '',
    stderr: '',
    outputTruncated: false,
  };
  try {
    const child = spawn(
      process.execPath,
      [host],
      // Survive libuv's parent-exit job long enough to settle our own job and write
      // its receipt. The controller pipe and native timeout still govern lifetime.
      { windowsHide: true, detached: true, shell: false, stdio: 'pipe' },
    );
    child.stdin.on('error', () => {});
    child.stderr.resume();
    const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
    let protocolFailed = false;
    let receivedResult = false;
    let stopping = false;
    let deadline: ReturnType<typeof setTimeout>;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(deadline);
      deadline = setTimeout(fail, processLimits.supervisorReportMs);
      if (!child.stdin.writableEnded) child.stdin.end('\n');
    };
    const fail = () => {
      protocolFailed = true;
      stop();
      child.kill();
    };
    child.on('error', () => {
      if (!child.pid) result = { ...result, reason: 'supervisor_unavailable', exitConfirmed: true };
      else fail();
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      try {
        if (line.length > commandLimits.protocolBytes || receivedResult) throw new Error('Invalid check protocol');
        // Any line that is not a valid `started` or `result` message fails the protocol below.
        const message = supervisorMessageSchema.parse(JSON.parse(line));
        if (message.type === 'started') {
          if (options.timeoutMs === 0 && !stopping) clearTimeout(deadline);
          options.started('tool', message.pid);
        } else {
          receivedResult = true;
          result = {
            ...result,
            reason: message.reason,
            exitCode: message.exitCode,
            exitConfirmed: message.exitConfirmed,
            ...(message.elapsedMs === null ? {} : { elapsedMs: message.elapsedMs }),
          };
          clearTimeout(deadline);
          deadline = setTimeout(fail, processLimits.supervisorReportMs);
        }
      } catch {
        fail();
      }
    });
    // Bound startup and shutdown even when the worker itself has no deadline.
    deadline = setTimeout(fail, options.timeoutMs + processLimits.supervisorReportMs);
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      if (child.pid) options.started('supervisor', child.pid);
      child.stdin.write(
        `${JSON.stringify({
          file: options.file,
          args: options.args,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          stdout,
          stderr,
          ...(options.receipt
            ? {
                receiptPath: join(directory, 'completion.json'),
                checkId: options.receipt.checkId,
                token: options.receipt.token,
              }
            : {}),
        })}\n`,
      );
      if (options.signal?.aborted) stop();
    } catch {
      fail();
    }
    await closed;
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', stop);
    lines.close();
    if (protocolFailed) result = { ...result, reason: 'supervisor_lost', exitConfirmed: false };
    return { ...result, ...retainedOutput(directory) };
  } finally {
    // Owned temporary output only. A dead supervisor closes the kill-on-close job.
    // Retain output on a cleanup failure rather than masking uncertain process state.
    if (!options.receipt) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* local diagnostics may remain */
      }
    }
  }
}
