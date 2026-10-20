// Owns immutable role assignments. Provider-specific effort and editing-provider restrictions are
// checked before approval, so changing a profile can never weaken independent review.
import { z } from 'zod';
import { profileLimits, planLimits } from '../config/limits.js';
import { providerSchema } from '../providers/types.js';

/** Effort values understood by the pinned provider protocols; omitted means provider default. */
export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** A fixed provider, requested model and optional reasoning effort. */
export const modelAssignmentSchema = z
  .strictObject({
    provider: providerSchema,
    model: z
      .string()
      .trim()
      .min(1)
      .max(planLimits.nameCharacters)
      .refine(value => !value.includes('\0'))
      .nullable(),
    effort: reasoningEffortSchema.exactOptional(),
  })
  .superRefine((value, context) => {
    if (value.provider === 'claude' && (value.effort === 'none' || value.effort === 'minimal'))
      context.addIssue({ code: 'custom', path: ['effort'], message: 'Effort is unsupported by this provider' });
  });
export type ModelAssignment = z.infer<typeof modelAssignmentSchema>;

/** A named profile is copied into each approved plan, rather than looked up during execution. */
export const modelProfileSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .max(planLimits.nameCharacters),
    name: z.string().trim().min(1).max(planLimits.nameCharacters),
    planning: modelAssignmentSchema,
    implementation: modelAssignmentSchema,
    repair: modelAssignmentSchema.exactOptional(),
    review: modelAssignmentSchema,
    qualityPasses: z.record(z.string().min(1).max(planLimits.nameCharacters), modelAssignmentSchema).exactOptional(),
    arbitration: modelAssignmentSchema.exactOptional(),
  })
  .superRefine((value, context) => {
    if (value.review.provider === value.implementation.provider)
      context.addIssue({ code: 'custom', path: ['review'], message: 'Independent review requires the other provider' });
    for (const [role, assignment] of [['repair', value.repair], ...Object.entries(value.qualityPasses ?? {})] as const)
      if (assignment && assignment.provider !== value.implementation.provider)
        context.addIssue({
          code: 'custom',
          path: [role],
          message: 'Editing roles must use the implementation provider',
        });
    if (Object.keys(value.qualityPasses ?? {}).length > profileLimits.qualityAssignments)
      context.addIssue({ code: 'custom', path: ['qualityPasses'], message: 'Too many quality pass assignments' });
  });
export type ModelProfile = z.infer<typeof modelProfileSchema>;

/** Validates a complete catalogue, including unique profile identities. */
export const modelProfilesSchema = z
  .array(modelProfileSchema)
  .max(profileLimits.profiles)
  .superRefine((profiles, context) => {
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length)
      context.addIssue({ code: 'custom', message: 'Model profile ids must be unique' });
  });

/** Resolves a profile once from settings or an inline definition and returns an independent copy. */
export function resolveModelProfile(value: unknown, available: readonly ModelProfile[]): ModelProfile {
  const raw = typeof value === 'string' ? available.find(profile => profile.id === value) : value;
  if (!raw) throw new Error(`Unknown model profile: ${String(value)}`);
  return structuredClone(modelProfileSchema.parse(raw));
}
