// The machine-readable report contract and targeted corrections share the driver's actual schema.
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { reviewReportSchema } from '../domain/review.js';
import { workerFile } from './workspace-files.js';

/** Resolve separate attempt files so corrections never overwrite their source evidence. */
export function correctStageReport(
  worktree: string,
  stage: 'spec-review' | 'review',
  round: number,
  attempt: number,
  specPath: string,
  error: string,
): string {
  const key = `${stage}:${round}`;
  return reportCorrection({
    previousPath: workerFile(worktree, attempt === 1 ? key : `${key}:attempt:${attempt - 1}`, 'report.json'),
    reportPath: workerFile(worktree, `${key}:attempt:${attempt}`, 'report.json'),
    specPath,
    kind: stage === 'spec-review' ? 'spec' : 'code',
    error,
  });
}

/** Give workers the complete strict schema and an executable check before submitting evidence. */
export function reportContract(reportPath: string, kind: 'spec' | 'code', specPath: string): string {
  const validator = fileURLToPath(new URL('../validate-report.js', import.meta.url));
  return `Complete JSON Schema (additional fields are forbidden):
${JSON.stringify(z.toJSONSchema(reviewReportSchema))}
Omit unknown optional locations; line numbers must be positive integers, never zero.
Before worker_done, validate the written report from the reviewed repository's working directory with:
node "${validator}" "${reportPath}" ${kind} "${specPath}"
Correct validation errors before submission. This checks format, coverage mapping and committed regression references, not behavioural truth; unknown evidence must remain unknown.`;
}

/** Correct an existing report at the same evidence binding without repeating its investigation. */
export function reportCorrection(input: {
  previousPath: string;
  reportPath: string;
  specPath: string;
  kind: 'spec' | 'code';
  error: string;
}): string {
  return `ROLE: report format correction, independent reviewer.
TARGET: existing report at ${input.previousPath}; specification at ${input.specPath}.
CHANGE: write a corrected report to ${input.reportPath}.
Validation error: ${input.error}
Read and repair the existing report. Do not repeat the investigation, rerun suites, change the candidate or spec, or invent evidence. Preserve findings, probe source, coverage gaps and uncertainty. Move unsupported extra-field evidence into the schema's existing evidence/detail fields rather than silently discarding it. If the prior report is missing or cannot support a conclusion, return unknown with unverified coverage. Do not upgrade a verdict merely to satisfy validation.
${reportContract(input.reportPath, input.kind, input.specPath)}
Then send worker_done with --outcome succeeded and --report-path ${input.reportPath}.`;
}
