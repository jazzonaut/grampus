// Pins the command-line contract: option values and the JSON files commands read. Arguments and files
// are user input; each is parsed here into a typed value, and a value that does not match is a
// `BoundaryError` (`cli-input`) naming the argument or file and the field, before any journal write.
// Semantic rules stay with the owning module: plans are normalised by domain/guided-plan.ts (passed on
// as `unknown`), briefs by domain/workflow.ts, policies, specs and assessments by the execution and
// verification modules that run them. Only their JSON shape is fixed here.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BoundaryError, describeIssues, parseJson } from './process/boundary.js';
import { providerSchema } from './providers/types.js';
import { editPolicySchema } from './execution/edit-policy.js';
import { checkSpecSchema, deliverySpecSchema, type CheckSpec, type DeliverySpec } from './persistence/records.js';
import { qualityAssessmentSchema, type QualityAssessment } from './domain/quality-passes.js';
import type { Brief } from './domain/workflow.js';
import type { EditPolicy } from './execution/edit-policy.js';
import type { Provider } from './providers/types.js';

/** Parse one argument or file; a mismatch is a `cli-input` `BoundaryError` naming `source` and each issue. */
function parseInput<S extends z.ZodType>(schema: S, value: unknown, source: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  throw new BoundaryError({ kind: 'cli-input', source }, issues, `Invalid ${source}: ${issues.join('; ')}`, {
    cause: result.error,
  });
}

/**
 * Read a JSON file named on the command line. Invalid JSON is a `cli-input` `BoundaryError` naming the
 * file; a file that cannot be read throws the file system error unchanged.
 */
export function readJsonFile(path: string): unknown {
  return parseJson(readFileSync(path, 'utf8'), { kind: 'cli-input', source: path });
}

const positive = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A positive integer argument such as a task version. Throws a plain `Error` with `message` otherwise. */
export function positiveInteger(value: string | undefined, message: string): number {
  const parsed = positive.safeParse(value);
  if (value === undefined || !parsed.success) throw new Error(message);
  return parsed.data;
}

/** `--timeout-ms` and `--interrupt-after-ms`: whole milliseconds; ranges are checked by the command. */
export function milliseconds(value: string, option: string): number {
  return parseInput(z.coerce.number().int(), value, `--${option}`);
}

/** `--port`: 0 lets the OS choose. Throws a plain `Error` outside that range. */
export function port(value: string): number {
  const parsed = z.coerce.number().int().min(0).max(65_535).safeParse(value);
  if (!parsed.success) throw new Error('Port must be 0–65535');
  return parsed.data;
}

/** `codex` or `claude`. */
export function provider(value: string | undefined, source = 'provider argument'): Provider {
  return parseInput(providerSchema, value, source);
}

/** `--role`, defaulting to implementation. */
export function executionRole(value: string | undefined): 'implementation' | 'review' {
  return parseInput(z.enum(['implementation', 'review']), value ?? 'implementation', '--role');
}

/** `--outcome` of a quality assessment; required, with no default, so an outcome is always stated. */
export function assessmentOutcome(value: string | undefined): QualityAssessment['outcome'] {
  return parseInput(z.enum(['passed', 'failed', 'skipped']), value, '--outcome');
}

/** A required, non-empty text option such as `--summary`. */
export function requiredText(value: string | undefined, option: string): string {
  return parseInput(z.string().min(1), value, `--${option}`);
}

/** Answers to pending questions, by question id. */
export function answersFile(path: string): Record<string, string> {
  return parseInput(z.record(z.string(), z.string()), readJsonFile(path), path);
}

const briefSchema = z.strictObject({
  title: z.string(),
  outcome: z.string(),
  criteria: z.array(z.string()),
  plan: z.string(),
  slices: z
    .array(z.strictObject({ title: z.string(), plan: z.string(), criteria: z.array(z.string()) }))
    .exactOptional(),
});

/** A low-level task brief; `Workflow.create` enforces its rules. */
export function briefFile(path: string): Brief {
  return parseInput(briefSchema, readJsonFile(path), path);
}

/** An explicit native editing policy; its schema is owned by execution/edit-policy.ts. */
export function editPolicyFile(path: string): EditPolicy {
  return parseInput(editPolicySchema, readJsonFile(path), path);
}

/** A delivery specification. Strict, so a misspelt field is refused rather than silently dropped. */
export function deliverySpecFile(path: string): DeliverySpec {
  return parseInput(z.strictObject(deliverySpecSchema.shape), readJsonFile(path), path);
}

/** A check or verification specification. Strict, so a misspelt field is refused rather than dropped. */
export function checkSpecFile(path: string): CheckSpec {
  return parseInput(z.strictObject(checkSpecSchema.shape), readJsonFile(path), path);
}

/** A quality assessment; its owner, domain/quality-passes.ts, fixes the shape and bounds. */
export function assessmentFile(path: string): QualityAssessment {
  return parseInput(qualityAssessmentSchema, readJsonFile(path), path);
}
