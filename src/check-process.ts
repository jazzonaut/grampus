import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { CheckReceipt } from './check-recovery.js';

export interface CheckProcessResult {
  reason: string;
  exitCode: number | null;
  exitConfirmed: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  outputUnavailable?: boolean;
}
export interface CheckProcessOptions {
  file: string; args: string[]; cwd: string; timeoutMs: number; signal?: AbortSignal;
  started: (kind: 'supervisor' | 'tool', pid: number) => void;
  receipt?: CheckReceipt;
}

function output(path: string): { text: string; truncated: boolean; available: boolean } {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { text: '', truncated: false, available: false }; }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, count).toString('utf8'), truncated: statSync(path).size > count, available: true };
  } finally { closeSync(fd); }
}

export function retainedOutput(directory: string): Pick<CheckProcessResult, 'stdout' | 'stderr' | 'outputTruncated' | 'outputUnavailable'> {
  const out = output(join(directory, 'stdout')); const err = output(join(directory, 'stderr'));
  return { stdout: out.text, stderr: err.text, outputTruncated: out.truncated || err.truncated, outputUnavailable: !out.available || !err.available };
}

/** Windows job supervision is deliberately separate from provider conversation processes. */
export async function runCheckProcess(options: CheckProcessOptions): Promise<CheckProcessResult> {
  if (process.platform !== 'win32') throw new Error('Repository checks currently require Windows 10 or later');
  if (options.signal?.aborted) return { reason: 'interrupted', exitCode: null, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  const directory = options.receipt?.directory ?? mkdtempSync(join(tmpdir(), 'grampus-check-'));
  const stdout = join(directory, 'stdout'); const stderr = join(directory, 'stderr');
  const host = fileURLToPath(new URL('./check-host.js', import.meta.url));
  let result: CheckProcessResult = { reason: 'supervisor_lost', exitCode: null, exitConfirmed: false, stdout: '', stderr: '', outputTruncated: false };
  try {
    const child = spawn(process.execPath, [host],
      // Survive libuv's parent-exit job long enough to settle our own job and write
      // its receipt. The controller pipe and native timeout still govern lifetime.
      { windowsHide: true, detached: true, shell: false, stdio: 'pipe' });
    child.stdin.on('error', () => {}); child.stderr.resume();
    const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
    let protocolFailed = false; let receivedResult = false;
    const stop = () => { if (!child.stdin.writableEnded) child.stdin.end('\n'); };
    const fail = () => { protocolFailed = true; stop(); child.kill(); };
    child.on('error', () => {
      if (!child.pid) result = { ...result, reason: 'supervisor_unavailable', exitConfirmed: true };
      else fail();
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      try {
        if (line.length > 4096 || receivedResult) throw new Error('Invalid check protocol');
        const message = JSON.parse(line) as { type: string; pid?: number; reason?: string; exitCode?: number; exitConfirmed?: boolean };
        if (message.type === 'started' && Number.isSafeInteger(message.pid) && message.pid! > 0) options.started('tool', message.pid!);
        else if (message.type === 'result' && typeof message.reason === 'string' && Number.isInteger(message.exitCode) && typeof message.exitConfirmed === 'boolean') {
          receivedResult = true;
          result = { ...result, reason: message.reason, exitCode: message.exitCode!, exitConfirmed: message.exitConfirmed };
        } else throw new Error('Invalid check protocol');
      } catch { fail(); }
    });
    // Includes helper compilation/startup and shutdown. Missing confirmation retains ownership.
    const deadline = setTimeout(fail, options.timeoutMs + 20_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      if (child.pid) options.started('supervisor', child.pid);
      child.stdin.write(`${JSON.stringify({ file: options.file, args: options.args, cwd: options.cwd, timeoutMs: options.timeoutMs, stdout, stderr,
        ...(options.receipt ? { receiptPath: join(directory, 'completion.json'), checkId: options.receipt.checkId, token: options.receipt.token } : {}) })}\n`);
      if (options.signal?.aborted) stop();
    } catch { fail(); }
    await closed;
    clearTimeout(deadline); options.signal?.removeEventListener('abort', stop); lines.close();
    if (protocolFailed) result = { ...result, reason: 'supervisor_lost', exitConfirmed: false };
    return { ...result, ...retainedOutput(directory) };
  } finally {
    // Owned temporary output only. A dead supervisor closes the kill-on-close job.
    // Retain output on a cleanup failure rather than masking uncertain process state.
    if (!options.receipt) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* local diagnostics may remain */ }
    }
  }
}
