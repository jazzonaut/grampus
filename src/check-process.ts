import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export interface CheckProcessResult {
  reason: string;
  exitCode: number | null;
  exitConfirmed: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}
export interface CheckProcessOptions {
  file: string; args: string[]; cwd: string; timeoutMs: number; signal?: AbortSignal;
  started: (kind: 'supervisor' | 'tool', pid: number) => void;
}

function output(path: string): { text: string; truncated: boolean } {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { text: '', truncated: false }; }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, count).toString('utf8'), truncated: statSync(path).size > count };
  } finally { closeSync(fd); }
}

/** Windows job supervision is deliberately separate from provider conversation processes. */
export async function runCheckProcess(options: CheckProcessOptions): Promise<CheckProcessResult> {
  if (process.platform !== 'win32') throw new Error('Repository checks currently require Windows 10 or later');
  if (options.signal?.aborted) return { reason: 'interrupted', exitCode: null, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  const directory = mkdtempSync(join(tmpdir(), 'grampus-check-'));
  const stdout = join(directory, 'stdout'); const stderr = join(directory, 'stderr');
  const script = fileURLToPath(new URL('../../src/native/check.ps1', import.meta.url));
  const powershell = resolve(process.env.SystemRoot ?? process.env.WINDIR ?? '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let result: CheckProcessResult = { reason: 'supervisor_lost', exitCode: null, exitConfirmed: false, stdout: '', stderr: '', outputTruncated: false };
  try {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, shell: false, stdio: 'pipe' });
    child.stdin.on('error', () => {}); child.stderr.resume();
    const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
    let protocolFailed = false; let receivedResult = false;
    const stop = () => { child.stdin.end('\n'); };
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
      child.stdin.write(`${JSON.stringify({ file: options.file, args: options.args, cwd: options.cwd, timeoutMs: options.timeoutMs, stdout, stderr })}\n`);
      if (options.signal?.aborted) stop();
    } catch { fail(); }
    await closed;
    clearTimeout(deadline); options.signal?.removeEventListener('abort', stop); lines.close();
    if (protocolFailed) result = { ...result, reason: 'supervisor_lost', exitConfirmed: false };
    const out = output(stdout); const err = output(stderr);
    return { ...result, stdout: out.text, stderr: err.text, outputTruncated: out.truncated || err.truncated };
  } finally {
    // Owned temporary output only. A dead supervisor closes the kill-on-close job.
    // Retain output on a cleanup failure rather than masking uncertain process state.
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* local diagnostics may remain */ }
  }
}
