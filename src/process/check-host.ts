import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { commandLimits, processLimits } from '../config/limits.js';

// A detached Node host survives the controller's libuv job. Windows PowerShell
// needs its normal hidden-console launch, so the host owns that child until exit.
// No tool parameters are interpreted here; the first line is forwarded as JSON.
const powershell = resolve(
  process.env.SystemRoot ?? process.env.WINDIR ?? '',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
const script = fileURLToPath(new URL('../../../src/process/native/check.ps1', import.meta.url));
const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  windowsHide: true,
  shell: false,
  stdio: 'pipe',
});
let writable = true;
process.stdout.on('error', () => {
  writable = false;
});
const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
output.on('line', line => {
  if (unlimited && !stopping) {
    try {
      const message = JSON.parse(line) as { type?: string };
      if (message.type === 'started') clearTimeout(deadline);
      if (message.type === 'result') {
        clearTimeout(deadline);
        deadline = setTimeout(() => child.kill(), processLimits.supervisorSettleMs);
      }
    } catch {
      /* The owning controller validates the protocol. */
    }
  }
  if (writable) process.stdout.write(`${line}\n`);
});
child.stderr.resume();
child.stdin.on('error', () => {});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requested = false;
let unlimited = false;
let stopping = false;
let deadline = setTimeout(() => child.kill(), processLimits.supervisorStartupMs);
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  deadline = setTimeout(() => child.kill(), processLimits.supervisorSettleMs);
  if (!child.stdin.writableEnded) child.stdin.end('\n');
};
input.on('line', line => {
  if (requested) {
    stop();
    return;
  }
  try {
    const request = JSON.parse(line) as Record<string, unknown>;
    clearTimeout(deadline);
    const timeout = Number(request['timeoutMs']);
    unlimited = timeout === 0;
    deadline = setTimeout(
      () => child.kill(),
      Number.isSafeInteger(timeout) && timeout >= commandLimits.minTimeoutMs && timeout <= commandLimits.maxTimeoutMs
        ? timeout + processLimits.supervisorSettleMs
        : processLimits.supervisorStartupMs,
    );
    child.stdin.write(`${JSON.stringify({ ...request, supervisorPid: process.pid })}\n`);
    requested = true;
  } catch {
    stop();
  }
});
input.on('close', stop);
process.stdin.on('error', stop);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('close', code => {
  stopping = true;
  clearTimeout(deadline);
  process.exitCode = code ?? 1;
  input.close();
  process.stdin.destroy();
});
