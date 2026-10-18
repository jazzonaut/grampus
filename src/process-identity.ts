import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProcessObservation = { state: 'present'; startedAt: string } | { state: 'absent' | 'unknown' };
export function validProcessStartTime(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
}

/** Query an OS creation time without rounding its 64-bit FILETIME through a JS number. */
export function inspectProcess(pid: number): ProcessObservation {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try {
    const powershell = resolve(
      process.env.SystemRoot ?? process.env.WINDIR ?? '',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const script = fileURLToPath(new URL('../../src/native/process.ps1', import.meta.url));
    const value = JSON.parse(
      execFileSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid)],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    ) as Record<string, unknown>;
    if (value.state === 'present' && validProcessStartTime(value.startedAt))
      return { state: 'present', startedAt: value.startedAt };
    if (value.state === 'absent') return { state: 'absent' };
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
