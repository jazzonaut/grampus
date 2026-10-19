// Owns process identity: Windows creation times that tell a recycled PID from the process that owned a
// run. The helper's output is validated by supervisor-protocol.ts; anything else is an unknown observation.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processLimits } from '../config/limits.js';
import { processObservationSchema } from './supervisor-protocol.js';

export { validProcessStartTime } from './supervisor-protocol.js';
export type ProcessObservation = { state: 'present'; startedAt: string } | { state: 'absent' | 'unknown' };

/** Query an OS creation time without rounding its 64-bit FILETIME through a JS number. */
export function inspectProcess(pid: number): ProcessObservation {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try {
    const powershell = resolve(
      process.env.SystemRoot ?? process.env.WINDIR ?? '',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const script = fileURLToPath(new URL('../../../src/process/native/process.ps1', import.meta.url));
    const value: unknown = JSON.parse(
      execFileSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid)],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: processLimits.identityTimeoutMs,
          maxBuffer: processLimits.identityOutputBytes,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ),
    );
    const observed = processObservationSchema.safeParse(value);
    if (observed.success) return observed.data;
  } catch {
    /* Missing helpers, denied access and timeouts cannot prove absence. */
  }
  return { state: 'unknown' };
}

let ownStartedAt: string | null | undefined;
export function currentProcessStartedAt(): string | null {
  if (ownStartedAt === undefined) {
    const observed = inspectProcess(process.pid);
    ownStartedAt = observed.state === 'present' ? observed.startedAt : null;
  }
  return ownStartedAt;
}
