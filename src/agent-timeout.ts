/** Zero disables the deadline; positive limits are an explicit low-level opt-in. */
export function agentTimeout(value: unknown = 0): number {
  if (!Number.isSafeInteger(value) || (value !== 0 && (Number(value) < 100 || Number(value) > 600_000))) {
    throw new Error('Agent timeout must be 0 (no deadline) or 100–600000 ms');
  }
  return Number(value);
}
