import { workflowPolicyBounds } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';

export interface WorkflowPolicy {
  mode: 'automatic' | 'supervised';
  repairRounds: number;
  maxSessionTurns: number;
  maxContextTokens: number;
}

/** Omitted fields come from the configured default policy (settings.ts); the result is approved as a whole. */
export function normalizeWorkflowPolicy(value: unknown): WorkflowPolicy {
  const defaultWorkflowPolicy = currentSettings().defaultWorkflowPolicy;
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
  for (const key of ['repairRounds', 'maxSessionTurns', 'maxContextTokens'] as const) {
    const { min, max } = workflowPolicyBounds[key];
    if (!Number.isSafeInteger(policy[key]) || policy[key] < min || policy[key] > max)
      throw new Error(`${key} must be ${min}–${max}`);
  }
  return policy;
}
