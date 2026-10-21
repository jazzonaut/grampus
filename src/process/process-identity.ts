// Owns process identity: Windows creation times that tell a recycled PID from the process that owned a
// run. The helper's output is validated by supervisor-protocol.ts; anything else is an unknown observation.
import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processLimits } from '../config/limits.js';
import { processObservationSchema } from './supervisor-protocol.js';
import { promisify } from 'node:util';

export { validProcessStartTime } from './supervisor-protocol.js';
/**
 * What the OS says about a PID. `present` carries its creation time, so a caller can tell the original
 * owner from a recycled PID; `unknown` never proves the process absent.
 */
export type ProcessObservation = { state: 'present'; startedAt: string } | { state: 'absent' | 'unknown' };

const execute = promisify(execFile);

function observationCommand(pid: number) {
  const file = resolve(
    process.env.SystemRoot ?? process.env.WINDIR ?? '',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const script = fileURLToPath(new URL('../../../src/process/native/process.ps1', import.meta.url));
  return { file, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid)] };
}

/** Same identity proof as synchronous recovery, without blocking the dashboard's event loop. */
export async function inspectProcessAsync(pid: number): Promise<ProcessObservation> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try {
    const { file, args } = observationCommand(pid);
    const { stdout } = await execute(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: processLimits.identityTimeoutMs,
      maxBuffer: processLimits.identityOutputBytes,
    });
    return processObservationSchema.safeParse(JSON.parse(stdout) as unknown).data ?? { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Query an OS creation time without rounding its 64-bit FILETIME through a JS number.
 *
 * Never throws: other platforms, invalid PIDs, a missing helper, denied access, a timeout or output that
 * does not match the pinned schema all return `unknown`.
 */
export function inspectProcess(pid: number): ProcessObservation {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try {
    const { file, args } = observationCommand(pid);
    const value: unknown = JSON.parse(
      execFileSync(file, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: processLimits.identityTimeoutMs,
        maxBuffer: processLimits.identityOutputBytes,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const observed = processObservationSchema.safeParse(value);
    if (observed.success) return observed.data;
  } catch {
    /* Missing helpers, denied access and timeouts cannot prove absence. */
  }
  return { state: 'unknown' };
}

let ownStartedAt: string | null | undefined;
/**
 * This controller's own creation time, recorded on leases and runs so recovery can later prove the owner
 * gone. Queried once and cached; `null` when it could not be observed.
 */
export function currentProcessStartedAt(): string | null {
  if (ownStartedAt === undefined) {
    const observed = inspectProcess(process.pid);
    ownStartedAt = observed.state === 'present' ? observed.startedAt : null;
  }
  return ownStartedAt;
}
