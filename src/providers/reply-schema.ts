// Pins the structured reply contract every agent turn must return, the usage snapshot providers report,
// and the turn result that the implementation worker hands back in `result.json`. Codex and Claude are
// both asked for `replyOutputSchema` (JSON Schema, sent to the provider); the controller then validates
// what actually came back with `agentReplySchema`. A reply that fails is a categorised `BoundaryError`
// (`agent-reply`) and fails the turn: a model reply is a proposal and is never trusted unvalidated.
import { z } from 'zod';
import { lensAssessmentsJsonSchema, lensAssessmentsSchema } from '../domain/quality-passes.js';

/** JSON Schema sent as the provider's structured output format. Strict mode needs every property required. */
export const replyOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priorFindings: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['resolved', 'unresolved'] },
          evidence: { type: 'string' },
        },
        required: ['id', 'status', 'evidence'],
      },
    },
    lenses: lensAssessmentsJsonSchema,
    kind: { type: 'string', enum: ['message', 'question', 'review'] },
    text: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'prompt', 'choices'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocking', 'suggestion'] },
          description: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'description', 'evidence'],
      },
    },
  },
  required: ['kind', 'text', 'questions', 'findings', 'lenses', 'priorFindings'],
};

const nonBlank = (what: string) => z.string().refine(value => value.trim() !== '', `${what} must not be blank`);

/** A clarifying question; an empty `choices` list allows free text. */
export const replyQuestionSchema = z.object({
  id: nonBlank('Question id'),
  prompt: nonBlank('Question prompt'),
  choices: z.array(z.string()),
});

/** A review finding; every finding needs concrete evidence. */
export const replyFindingSchema = z.object({
  severity: z.enum(['blocking', 'suggestion']),
  description: nonBlank('Finding description'),
  evidence: nonBlank('Finding evidence'),
});

/**
 * The structured reply. Beyond field types it enforces the cross-field rules the controller relies on:
 * question ids are unique and only `question` replies carry questions. Provisional review assessments
 * may accompany a question, but only a settled review can supply a verdict.
 */
export const agentReplySchema = z
  .object({
    /** Review progress claims; the controller checks coverage against its finding identities. */
    priorFindings: z
      .array(
        z.object({
          id: nonBlank('Prior finding id'),
          status: z.enum(['resolved', 'unresolved']),
          evidence: nonBlank('Resolution evidence'),
        }),
      )
      .nullable()
      .exactOptional(),
    /** Review assessments on a verdict or provisional assessments accompanying a question. */
    lenses: lensAssessmentsSchema.nullable().exactOptional(),
    kind: z.enum(['message', 'question', 'review']),
    text: z.string(),
    questions: z.array(replyQuestionSchema),
    findings: z.array(replyFindingSchema),
  })
  .superRefine((reply, context) => {
    if (new Set(reply.questions.map(question => question.id)).size !== reply.questions.length)
      context.addIssue({ code: 'custom', path: ['questions'], message: 'Question ids must be unique' });
    if ((reply.kind === 'question') !== reply.questions.length > 0)
      context.addIssue({ code: 'custom', path: ['kind'], message: 'Questions require kind=question and vice versa' });
    // Implementers can report observations without impersonating the independent reviewer.
    // Evidence attribution follows the execution role, never the presence of a findings list.
    if (reply.lenses != null && reply.kind === 'message')
      context.addIssue({ code: 'custom', path: ['lenses'], message: 'Only a review may assess lenses' });
    if (reply.priorFindings?.length && reply.kind === 'message')
      context.addIssue({ code: 'custom', path: ['priorFindings'], message: 'Only a review may resolve findings' });
  });

/** A validated structured agent reply. */
export type Reply = z.infer<typeof agentReplySchema>;

const count = z.number().nullable();

/**
 * Cumulative usage of one provider session. Unknown values stay null; billed cost is never known locally.
 * `cachedInputTokens` counts prompt-cache reads and `cacheWriteInputTokens` prompt-cache writes (Claude's
 * cache creation tokens, Codex's cache write tokens), each as the provider reports them.
 */
export const usageSchema = z.object({
  scope: z.literal('provider-session-cumulative'),
  complete: z.boolean().exactOptional(),
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count,
  estimatedCostUsd: count,
  billedCostUsd: z.null(),
});
export type Usage = z.infer<typeof usageSchema>;

/** How one agent turn ended. A reply is present only for a completed turn. */
export const turnResultSchema = z.object({
  status: z.enum(['completed', 'interrupted', 'failed']),
  reply: agentReplySchema.nullable(),
  usage: usageSchema.nullable(),
  error: z.string().nullable(),
  /** Set when Grampus refused the turn before dispatch because its prompt could not fit the budget. */
  refused: z.literal('prompt_budget').exactOptional(),
});
export type TurnResult = z.infer<typeof turnResultSchema>;
