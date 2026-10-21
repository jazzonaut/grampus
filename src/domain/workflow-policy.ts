// Owns the workflow policy a guided plan approves: automatic or supervised mode, readiness and shared
// behavioural repair allowances, task spending limits and provider conversation thresholds. Normalisation fills omitted fields from the
// configured defaults once, so the approved digest binds the effective values, not the defaults.
import { z } from 'zod';
import { contextLimits, workflowPolicyBounds } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';

/** A normalised workflow policy as stored in an approved plan. Bounds are enforced by normalisation. */
export const workflowPolicySchema = z.object({
  mode: z.enum(['automatic', 'supervised']),
  readinessRounds: z.number(),
  repairRounds: z.number(),
  maxSessionTurns: z.number(),
  maxContextTokens: z.number(),
  maxTaskTurns: z.number().int().min(workflowPolicyBounds.maxTaskTurns.min).max(workflowPolicyBounds.maxTaskTurns.max),
  maxTaskTokens: z
    .number()
    .int()
    .min(workflowPolicyBounds.maxTaskTokens.min)
    .max(workflowPolicyBounds.maxTaskTokens.max),
});
export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;

const policyKeys = [
  'mode',
  'readinessRounds',
  'repairRounds',
  'maxSessionTurns',
  'maxContextTokens',
  'maxTaskTurns',
  'maxTaskTokens',
] as const;

/**
 * Validates a plan's `workflowPolicy` input. Omitted fields come from the configured default policy
 * (settings.ts); the result is approved as a whole, so a later settings change never alters an approved
 * plan. Throws a message naming the offending field.
 */
export function normalizeWorkflowPolicy(value: unknown): WorkflowPolicy {
  const defaultWorkflowPolicy = currentSettings().defaultWorkflowPolicy;
  if (value === undefined) return { ...defaultWorkflowPolicy };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !policyKeys.some(allowed => allowed === key))
  )
    throw new Error('Invalid workflow policy');
  const merged: Record<string, unknown> = { ...defaultWorkflowPolicy, ...value };
  const mode = merged['mode'];
  if (mode !== 'automatic' && mode !== 'supervised') throw new Error('Workflow mode must be automatic or supervised');
  const bounded = (key: Exclude<(typeof policyKeys)[number], 'mode'>): number => {
    const { min, max } = workflowPolicyBounds[key];
    const field = merged[key];
    if (key === 'maxContextTokens' && typeof field === 'number' && field > 0 && field < contextLimits.minimumTokens)
      throw new Error(`maxContextTokens must be zero (automatic) or at least ${contextLimits.minimumTokens}`);
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < min || field > max)
      throw new Error(`${key} must be ${min}–${max}`);
    return field;
  };
  return {
    mode,
    readinessRounds: bounded('readinessRounds'),
    repairRounds: bounded('repairRounds'),
    maxSessionTurns: bounded('maxSessionTurns'),
    maxContextTokens: bounded('maxContextTokens'),
    maxTaskTurns: bounded('maxTaskTurns'),
    maxTaskTokens: bounded('maxTaskTokens'),
  };
}
