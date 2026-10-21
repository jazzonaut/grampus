// Review reports written by reviewer workers. Only a blocking finding with a location and a concrete
// failing scenario can send work back to repair: LLM reviewers asked to find problems always find some,
// so unsupported findings are kept as notes rather than allowed to drive repair.
import { z } from 'zod';
import { reviewLimits } from '../config/limits.js';

const text = z.string().max(reviewLimits.textLength);

export const findingSchema = z
  .object({
    severity: z.enum(['blocking', 'note']),
    title: text.min(1),
    file: text.optional(),
    line: z.number().int().positive().optional(),
    /** The spec criterion the finding concerns, quoted. */
    criterion: text.optional(),
    /** Inputs or steps that produce the wrong behaviour. Required for a blocking code finding. */
    scenario: text.optional(),
    detail: text.optional(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const reviewReportSchema = z
  .object({
    /** `unknown` is allowed when the reviewer cannot decide; it never counts as approval. */
    verdict: z.enum(['approve', 'changes', 'unknown']),
    summary: text,
    findings: z.array(findingSchema).max(reviewLimits.findings),
  })
  .strict();
export type ReviewReport = z.infer<typeof reviewReportSchema>;

/** A code review after Grampus applied its blocking rule. */
export interface ReviewOutcome {
  report: ReviewReport;
  /** Findings that may send the work back to repair. */
  blocking: Finding[];
  /** Findings the reviewer marked blocking without the support the rule requires. */
  downgraded: Finding[];
}

/** Parse a review report file's text. Throws with a message that names the problem. */
export function parseReviewReport(json: string): ReviewReport {
  if (Buffer.byteLength(json) > reviewLimits.bytes)
    throw new Error(`The review report is larger than ${reviewLimits.bytes} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`The review report is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  const report = reviewReportSchema.safeParse(value);
  if (!report.success) throw new Error(`The review report is invalid: ${report.error.message}`);
  return report.data;
}

/** Apply the blocking rule to a code review: a blocker needs a file, a line and a failing scenario. */
export function judgeCodeReview(report: ReviewReport): ReviewOutcome {
  const claimed = report.findings.filter(finding => finding.severity === 'blocking');
  const supported = (finding: Finding) => Boolean(finding.file && finding.line && finding.scenario?.trim());
  return {
    report,
    blocking: claimed.filter(supported),
    downgraded: claimed.filter(finding => !supported(finding)),
  };
}
