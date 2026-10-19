// Owns controller-side supervision of one Windows Job Object run: it launches the detached check host,
// validates the supervisor's line protocol and reads bounded output previews. It never interprets the
// tool's output or exit code as success; a launched run's exit is confirmed only by the supervisor's report.
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
/** One supervised run: a literal executable and arguments started at `cwd` without a shell. */
export interface CheckProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  /** Zero disables the runtime deadline for agent workers. */
  timeoutMs: number;
  /** Aborting asks the supervisor to stop the job; the run still waits for its result. */
  signal?: AbortSignal;
  /** Called with the check host's PID once spawned, then with the tool's PID when the supervisor reports it. */
  started: (kind: 'supervisor' | 'tool', pid: number) => void;
  /** With a receipt, output and `completion.json` go to its durable directory and are kept afterwards. */
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

/**
 * Read the first `commandLimits.previewBytes` of the `stdout` and `stderr` logs in a run directory. Used
 * both after a live run and by recovery reading a settled receipt directory. A log that cannot be opened
 * is reported as `outputUnavailable` rather than silently passed off as empty output.
 */
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

/**
 * The single request line the check host forwards to the supervisor: the literal command, its output
 * logs in `directory` and, with a receipt, where and under which token to write settlement proof.
 */
function hostRequest(options: CheckProcessOptions, directory: string) {
  return {
    file: options.file,
    args: options.args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    stdout: join(directory, 'stdout'),
    stderr: join(directory, 'stderr'),
    ...(options.receipt
      ? {
          receiptPath: join(directory, 'completion.json'),
          checkId: options.receipt.checkId,
          token: options.receipt.token,
        }
      : {}),
  };
}

/**
 * Run one tool under the Windows Job Object supervisor and report how it ended.
 *
 * Windows job supervision is deliberately separate from provider conversation processes. The result
 * starts as `supervisor_lost` with an unconfirmed exit and only the supervisor's `result` line replaces
 * it; an invalid, extra or oversized line, a host that cannot be reached or a missed deadline kills the
 * host and keeps `supervisor_lost`, so an unknown outcome is never reported as an exit. A host that never
 * got a PID is `supervisor_unavailable` with a confirmed exit, because nothing was started.
 *
 * @throws Error for a timeout outside `commandLimits` (other than zero) or on a platform other than Windows.
 */
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
    // A second line (or end of input) is the stop request: the host and the native supervisor treat it as
    // an interruption, then must still report and exit within the report window.
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
          // An unlimited worker may run for as long as it needs once it has started.
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
          // The host must still exit after reporting; until it closes, the result is not final.
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
      child.stdin.write(`${JSON.stringify(hostRequest(options, directory))}\n`);
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
