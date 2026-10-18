import { commandLimits } from '../config/limits.js';

/** Zero disables the deadline; positive limits are an explicit low-level opt-in. */
export function agentTimeout(value: unknown = 0): number {
  const { minTimeoutMs: min, maxTimeoutMs: max } = commandLimits;
  if (!Number.isSafeInteger(value) || (value !== 0 && (Number(value) < min || Number(value) > max))) {
    throw new Error(`Agent timeout must be 0 (no deadline) or ${min}–${max} ms`);
  }
  return Number(value);
}
