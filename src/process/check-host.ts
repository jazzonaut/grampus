// Owns the detached Node host that runs the native Job Object supervisor (native/check.ps1) for one check
// and relays its stdout lines to the controller unchanged. Protocol validation stays with the controller and
// tool parameters are not interpreted; the host only bounds the supervisor's lifetime and forwards one request
// (adding its own PID) plus a stop signal.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { commandLimits, processLimits } from '../config/limits.js';
import { checkHostRequestSchema, supervisorMessageSchema } from './supervisor-protocol.js';

// A detached Node host survives the controller's libuv job. Windows PowerShell
// needs its normal hidden-console launch, so the host owns that child until exit.
// No tool parameters are interpreted here; the first line is forwarded as JSON.
const powershell = resolve(
  process.env.SystemRoot ?? process.env.WINDIR ?? '',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
const script = fileURLToPath(new URL('../../../src/process/native/check.ps1', import.meta.url));
const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  // Add-Type resolves framework references from the process working directory. A dashboard
  // launched in PowerShell 7's directory would otherwise pick up incompatible .NET assemblies.
  cwd: dirname(script),
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
  // Without a tool deadline, only startup and the post-result settle window are bounded here.
  if (unlimited && !stopping) {
    try {
      const message = supervisorMessageSchema.safeParse(JSON.parse(line));
      if (message.data?.type === 'started') clearTimeout(deadline);
      if (message.data?.type === 'result') {
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
// The first line is the request; any later line, end of input or a broken pipe is a stop request.
input.on('line', line => {
  if (requested) {
    stop();
    return;
  }
  try {
    const request = checkHostRequestSchema.parse(JSON.parse(line));
    clearTimeout(deadline);
    const timeout = request.timeoutMs;
    unlimited = timeout === 0;
    // A zero or out-of-range timeout keeps only the startup bound (zero clears it once the tool starts);
    // otherwise this is the backstop that kills a supervisor which has not settled after the tool deadline.
    deadline = setTimeout(
      () => child.kill(),
      Number.isSafeInteger(timeout) && timeout >= commandLimits.minTimeoutMs && timeout <= commandLimits.maxTimeoutMs
        ? timeout + processLimits.supervisorSettleMs
        : processLimits.supervisorStartupMs,
    );
    // The host's own PID is the supervisor identity the receipt records alongside its creation time.
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
