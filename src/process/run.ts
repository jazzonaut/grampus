// Runs a child process to completion and captures its output. Used for the Orca and Git CLIs; checks
// have their own runner because they stream to log files and need process-tree termination.
import { spawn, spawnSync } from 'node:child_process';
import { processLimits } from '../config/limits.js';

/** The settled result of one child process. */
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
}

/**
 * Run `file` with `args` (no shell) and collect its output. Output beyond the process limit fails the
 * call rather than truncating JSON that a caller would then misread.
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > processLimits.outputBytes) {
        overflow = true;
        terminateTree(child.pid);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child.pid);
    }, options.timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (overflow) {
        reject(new Error(`${file} produced more than ${processLimits.outputBytes} bytes of output`));
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });
    child.stdin.end(options.input ?? '');
  });
}

/** Terminate a process and its descendants. Windows needs taskkill because killing a shell orphans its children. */
export function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
}
