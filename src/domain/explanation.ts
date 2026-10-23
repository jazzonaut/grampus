// Versioned change explanations and answers. References name lines in a committed candidate, so a
// repair never silently makes an old explanation look current.
import { z } from 'zod';
import { explanationLimits } from '../config/limits.js';

export const codeReferenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(explanationLimits.pathLength)
      .refine(
        value =>
          !value.startsWith('/') &&
          !value.includes('\\') &&
          !value.split('/').some(part => part === '..' || part === '.' || !part),
        'a relative repository path',
      ),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .refine(value => value.end >= value.start, 'the end must follow the start');
export type CodeReference = z.infer<typeof codeReferenceSchema>;

export const explanationSchema = z.object({
  problem: z.string().max(explanationLimits.textLength),
  beforeAfter: z.string().max(explanationLimits.textLength),
  architecture: z.string().max(explanationLimits.textLength),
  approach: z.string().max(explanationLimits.textLength),
  decisions: z.string().max(explanationLimits.textLength),
  validation: z.string().max(explanationLimits.textLength),
  limitations: z.string().max(explanationLimits.textLength),
  groups: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        title: z.string().min(1).max(explanationLimits.titleLength),
        purpose: z.string().max(explanationLimits.textLength),
        references: z.array(codeReferenceSchema).min(1).max(explanationLimits.references),
      }),
    )
    .min(1)
    .max(explanationLimits.groups)
    .refine(groups => new Set(groups.map(group => group.id)).size === groups.length, 'group ids must be unique'),
});
export type Explanation = z.infer<typeof explanationSchema>;

export const answerSchema = z.object({
  answer: z.string().min(1).max(explanationLimits.textLength),
  references: z.array(codeReferenceSchema).max(explanationLimits.references),
});
export type ExplanationAnswer = z.infer<typeof answerSchema>;
