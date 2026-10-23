// The spec a worker writes and the user approves: Markdown for people plus one fenced `grampus` JSON
// block that Grampus acts on (check commands and protected paths). Approval binds the exact bytes by
// hash, so a later edit is a new version.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { specLimits } from '../config/limits.js';

export const checkDefinitionSchema = z
  .object({
    name: z.string().min(1).max(specLimits.checkNameLength),
    command: z.string().min(1).max(specLimits.checkCommandLength),
    timeoutSeconds: z.number().int().positive().max(specLimits.checkTimeoutSeconds).optional(),
    /** Explicitly approved stable interface for transferring this check between implementations. */
    portable: z.boolean().optional(),
  })
  .strict();
export type CheckDefinition = z.infer<typeof checkDefinitionSchema>;

const acceptanceText = z.string().trim().min(1).max(specLimits.acceptanceTextLength);
/** One requested outcome and the boundary at which its acceptance can actually be observed. */
export const acceptanceSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(specLimits.checkNameLength),
    request: acceptanceText,
    scenario: acceptanceText,
    checks: z.array(z.string().min(1).max(specLimits.checkNameLength)).min(1).max(specLimits.checks),
    realComponents: z.array(acceptanceText).min(1).max(specLimits.acceptanceScenarios),
    mockedComponents: z.array(acceptanceText).max(specLimits.acceptanceScenarios),
    limitations: z.array(acceptanceText).max(specLimits.acceptanceScenarios),
  })
  .strict();
export type AcceptanceScenario = z.infer<typeof acceptanceSchema>;

const specBlockSchema = z
  .object({
    /** Commands Grampus runs in the worktree. Every one must pass at the head commit. */
    checks: z.array(checkDefinitionSchema).min(1).max(specLimits.checks),
    /** Repository globs the builder must not change, such as approved acceptance tests. */
    protected: z.array(z.string().min(1).max(specLimits.pathLength)).max(specLimits.protectedPaths).default([]),
    acceptance: z.array(acceptanceSchema).min(1).max(specLimits.acceptanceScenarios),
  })
  .strict();
export type SpecBlock = z.infer<typeof specBlockSchema>;

/** A parsed spec version. */
export interface Spec {
  markdown: string;
  hash: string;
  block: SpecBlock;
}

const blockPattern = /^```grampus[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Parse a spec file. Throws with a message a worker can act on when the file is unusable. */
export function parseSpec(markdown: string): Spec {
  if (Buffer.byteLength(markdown) > specLimits.bytes)
    throw new Error(`The spec is larger than ${specLimits.bytes} bytes.`);
  const blocks = [...markdown.matchAll(blockPattern)];
  if (blocks.length !== 1)
    throw new Error(`The spec must contain exactly one fenced \`grampus\` JSON block; found ${blocks.length}.`);
  let json: unknown;
  try {
    json = JSON.parse(blocks[0]?.[1] ?? '');
  } catch (error) {
    throw new Error(`The \`grampus\` block is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  const block = specBlockSchema.safeParse(json);
  if (!block.success) throw new Error(`The \`grampus\` block is invalid: ${block.error.message}`);
  const names = block.data.checks.map(check => check.name);
  if (new Set(names).size !== names.length) throw new Error('Check names in the `grampus` block must be unique.');
  const ids = block.data.acceptance.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Acceptance scenario ids must be unique.');
  for (const item of block.data.acceptance)
    if (item.checks.some(name => !names.includes(name)))
      throw new Error(`Acceptance ${item.id} names an undeclared check.`);
  return { markdown, hash: hashText(markdown), block: block.data };
}

/** SHA-256 of text, used to bind approvals and evidence to exact content. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
