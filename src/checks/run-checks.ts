// Runs the approved check commands in a task worktree. This is the deterministic verifier the pipeline
// depends on: an agent's report that tests pass is never evidence, these results are. Output streams
// to a log file as it is produced, so a check that times out keeps what it printed.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { checkLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import type { CheckResult } from '../domain/events.js';
import type { CheckDefinition } from '../domain/spec.js';
import { terminateTree } from '../process/run.js';
import { safeName } from '../store/task-store.js';

interface Attempt {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logPath: string;
}

/**
 * Run each check in order at the worktree's current commit. With `rerunFailures`, a failing check runs
 * once more: a pass on the second attempt is recorded as flaky and counts as passing. Aborting `signal`
 * terminates the running check and skips the rest; the partial results are then not evidence.
 */
export async function runChecks(
  cwd: string,
  checks: readonly CheckDefinition[],
  logDir: string,
  options: { rerunFailures: boolean; signal?: AbortSignal },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (options.signal?.aborted) break;
    const base = join(logDir, safeName(check.name));
    let attempt = await runCheck(cwd, check, `${base}.log`, options.signal);
    let flaky = false;
    if (!passed(attempt) && options.rerunFailures && !options.signal?.aborted) {
      attempt = await runCheck(cwd, check, `${base}.rerun.log`, options.signal);
      flaky = passed(attempt);
    }
    results.push({ name: check.name, command: check.command, ...attempt, flaky, passed: passed(attempt) });
  }
  return results;
}

function passed(attempt: Attempt): boolean {
  return attempt.exitCode === 0 && !attempt.timedOut;
}

function runCheck(cwd: string, check: CheckDefinition, logPath: string, signal?: AbortSignal): Promise<Attempt> {
  const settings = currentSettings();
  const timeoutMs = (check.timeoutSeconds ?? settings.defaultCheckTimeoutSeconds) * 1000;
  const log = openSync(logPath, 'w');
  let written = 0;
  const write = (chunk: Buffer) => {
    const room = checkLimits.logBytes - written;
    if (room <= 0) return;
    written += writeSync(log, chunk, 0, Math.min(room, chunk.length));
    if (written >= checkLimits.logBytes)
      writeSync(log, `\n[grampus: output beyond ${checkLimits.logBytes} bytes omitted]\n`);
  };
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn(check.command, {
      cwd,
      shell: settings.checkShell ?? true,
      windowsHide: true,
      // A process group on POSIX lets a timeout terminate everything the shell started.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child.pid);
    }, timeoutMs);
    const abort = () => terminateTree(child.pid);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    let settled = false;
    // A spawn failure can emit both `error` and `close`; the first one settles the attempt.
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const durationMs = Math.round(performance.now() - started);
      if (timedOut) writeSync(log, `\n[grampus: timed out after ${timeoutMs} ms]\n`);
      closeSync(log);
      resolve({ exitCode, timedOut, durationMs, logPath });
    };
    child.on('error', error => {
      if (!settled) writeSync(log, `\n[grampus: could not start: ${error.message}]\n`);
      finish(null);
    });
    child.on('close', code => finish(code));
  });
}

/** The tail of a check log, for repair workers and reviewers. */
export function logExcerpt(path: string): string {
  const size = statSync(path).size;
  const length = Math.min(size, checkLimits.excerptBytes);
  const buffer = Buffer.alloc(length);
  const handle = openSync(path, 'r');
  try {
    readSync(handle, buffer, 0, length, size - length);
  } finally {
    closeSync(handle);
  }
  const text = buffer.toString('utf8');
  return size > length ? `[... ${size - length} earlier bytes in ${path}]\n${text}` : text;
}
