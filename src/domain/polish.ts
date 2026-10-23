// Polish reports separate behavioural safety from an evidenced maintenance benefit.
import { z } from 'zod';
import { reviewLimits } from '../config/limits.js';
import { reviewReportSchema } from './review.js';

const text = z.string().trim().min(1).max(reviewLimits.textLength);
export const polishReportSchema = z
  .object({
    summary: text,
    improvements: z
      .array(
        z
          .object({
            category: z.enum(['naming', 'duplication', 'structure', 'cleanup', 'consistency']),
            files: z.array(text).min(1).max(reviewLimits.findings),
            benefit: text,
            /** Why an edit outside the original change is necessary, or null when all edits are in it. */
            adjacentReason: text.nullable(),
          })
          .strict(),
      )
      .max(reviewLimits.findings),
  })
  .strict();
export type PolishReport = z.infer<typeof polishReportSchema>;

export const maintenanceSchema = z
  .object({
    verdict: z.enum(['worth-keeping', 'no-benefit', 'unknown']),
    rationale: text,
  })
  .strict();
export type MaintenanceAssessment = z.infer<typeof maintenanceSchema>;

export const polishReviewSchema = reviewReportSchema.extend({ maintenance: maintenanceSchema });

/** Parse bounded worker evidence. Malformed or missing evidence never authorises retaining edits. */
export function parsePolishReport(json: string): PolishReport {
  if (Buffer.byteLength(json) > reviewLimits.bytes) throw new Error('Polish report exceeds the report limit.');
  return polishReportSchema.parse(JSON.parse(json));
}
