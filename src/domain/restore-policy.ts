// Owns the explicit, approval-bound contract for skipping repeatable local prerequisite restoration.
import { z } from 'zod';
import { checkReuseSchema } from './check-input-policy.js';

/** Inputs include all restore scripts/configuration; outputs identify the managed prerequisite trees. */
export const restorePolicySchema = z.strictObject({
  inputs: checkReuseSchema.shape.inputs,
  outputs: checkReuseSchema.shape.inputs.min(1),
});
