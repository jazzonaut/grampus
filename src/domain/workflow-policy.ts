export interface WorkflowPolicy {
  mode: 'automatic' | 'supervised';
  repairRounds: number;
  maxSessionTurns: number;
  maxContextTokens: number;
}

export const defaultWorkflowPolicy: WorkflowPolicy = {
  mode: 'automatic',
  repairRounds: 2,
  maxSessionTurns: 6,
  maxContextTokens: 120000,
};

export function normalizeWorkflowPolicy(value: unknown): WorkflowPolicy {
  if (value === undefined) return { ...defaultWorkflowPolicy };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !['mode', 'repairRounds', 'maxSessionTurns', 'maxContextTokens'].includes(key))
  )
    throw new Error('Invalid workflow policy');
  const policy = { ...defaultWorkflowPolicy, ...value };
  if (!['automatic', 'supervised'].includes(policy.mode))
    throw new Error('Workflow mode must be automatic or supervised');
  for (const [key, min, max] of [
    ['repairRounds', 0, 5],
    ['maxSessionTurns', 1, 50],
    ['maxContextTokens', 8000, 1000000],
  ] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < min || policy[key] > max)
      throw new Error(`${key} must be ${min}–${max}`);
  }
  return policy;
}
