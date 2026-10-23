// Review reports written by reviewer workers. Only a blocking finding with a location and a concrete
// failing scenario can send work back to repair: LLM reviewers asked to find problems always find some,
// so unsupported findings are kept as notes rather than allowed to drive repair.
import { z } from 'zod';
import { reviewLimits } from '../config/limits.js';

const text = z.string().max(reviewLimits.textLength);
const evidenceText = text.trim().min(1);
const requestCoverageSchema = z
  .object({
    verdict: z.enum(['covered', 'gaps', 'unknown']),
    rationale: evidenceText,
  })
  .strict();
const coverageSchema = z
  .object({
    acceptanceId: evidenceText,
    status: z.enum(['verified', 'unverified']),
    evidence: evidenceText,
    limitations: z.array(evidenceText).max(reviewLimits.findings),
  })
  .strict();

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
    /** Required for spec and implementation reviews; polish reviews assess only the maintenance diff. */
    requestCoverage: requestCoverageSchema.optional(),
    /** Required, complete and unique for implementation reviews. */
    coverage: z.array(coverageSchema).max(reviewLimits.findings).optional(),
    /** Reproducible probes used to establish requested outcomes, retained for the repair worker. */
    probes: z
      .array(
        z
          .object({
            scenario: evidenceText,
            suggestedPath: evidenceText,
            command: evidenceText,
            source: z.string().trim().min(1).max(reviewLimits.probeSourceLength),
            regressionTest: z.object({ file: evidenceText, test: evidenceText }).strict().nullable(),
          })
          .strict(),
      )
      .max(reviewLimits.findings)
      .optional(),
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

/** Missing or duplicate acceptance evidence is unavailable review, never implicit approval. */
export function validateCoverage(report: ReviewReport, acceptanceIds?: readonly string[]): void {
  if (!report.requestCoverage) throw new Error('Request coverage assessment is missing.');
  if (!acceptanceIds) return;
  const ids = report.coverage?.map(item => item.acceptanceId) ?? [];
  if (
    ids.length !== acceptanceIds.length ||
    new Set(ids).size !== ids.length ||
    acceptanceIds.some(id => !ids.includes(id))
  )
    throw new Error('Acceptance coverage must name every approved scenario exactly once.');
  if (!report.probes) throw new Error('Review probes must be declared, using an empty array when none were needed.');
}

/** Coverage problems prevent readiness, even when a recipe permits automatic repair. */
export function coverageProblems(report: ReviewReport): string[] {
  const problems: string[] = [];
  if (report.requestCoverage?.verdict !== 'covered')
    problems.push(
      `original request coverage ${report.requestCoverage?.verdict ?? 'unknown'}: ${report.requestCoverage?.rationale ?? 'unavailable'}`,
    );
  for (const item of report.coverage ?? [])
    if (item.status === 'unverified')
      problems.push(`unverified outcome ${item.acceptanceId}: ${item.evidence} ${item.limitations.join(' ')}`);
  for (const probe of report.probes ?? [])
    if (!probe.regressionTest)
      problems.push(
        `Preserve review probe as a committed regression test: ${probe.scenario}. Suggested file: ${probe.suggestedPath}. Run: ${probe.command}\n${probe.source}`,
      );
  return problems;
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
