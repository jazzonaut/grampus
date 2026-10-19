// Owns validation of the optional wall-clock deadline for a provider turn. It only checks the bound;
// it does not start timers or stop processes.
import { commandLimits } from '../config/limits.js';

/**
 * Validate an agent turn deadline in milliseconds. Zero disables the deadline; positive limits are an
 * explicit low-level opt-in and share the command timeout bounds in `commandLimits`.
 *
 * @throws Error when the value is not a safe integer, or is non-zero and outside those bounds.
 */
export function agentTimeout(value: unknown = 0): number {
  const { minTimeoutMs: min, maxTimeoutMs: max } = commandLimits;
  if (!Number.isSafeInteger(value) || (value !== 0 && (Number(value) < min || Number(value) > max))) {
    throw new Error(`Agent timeout must be 0 (no deadline) or ${min}–${max} ms`);
  }
  return Number(value);
}
