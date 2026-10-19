// Pins the structured reply contract every agent turn must return, the usage snapshot providers report,
// and the turn result that the implementation worker hands back in `result.json`. Codex and Claude are
// both asked for `replyOutputSchema` (JSON Schema, sent to the provider); the controller then validates
// what actually came back with `agentReplySchema`. A reply that fails is a categorised `BoundaryError`
// (`agent-reply`) and fails the turn: a model reply is a proposal and is never trusted unvalidated.
import { z } from 'zod';
import { reviewLimits } from '../config/limits.js';

/** JSON Schema sent as the provider's structured output format. Strict mode needs every property required. */
export const replyOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    simplification: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { outcome: { type: 'string', enum: ['passed', 'failed'] }, summary: { type: 'string' } },
          required: ['outcome', 'summary'],
        },
      ],
    },
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
  required: ['kind', 'text', 'questions', 'findings', 'simplification'],
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

/** The reviewer's independent simplification verdict, only allowed on a review. */
export const simplificationVerdictSchema = z.object({
  outcome: z.enum(['passed', 'failed']),
  summary: nonBlank('Simplification summary').refine(
    value => Buffer.byteLength(value) <= reviewLimits.simplificationSummaryBytes,
    `Simplification summary exceeds ${reviewLimits.simplificationSummaryBytes} bytes`,
  ),
});

/**
 * The structured reply. Beyond field types it enforces the cross-field rules the controller relies on:
 * question ids are unique, `question` replies and only those carry questions, only reviews carry
 * findings or a simplification verdict.
 */
export const agentReplySchema = z
  .object({
    simplification: simplificationVerdictSchema.nullable().exactOptional(),
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
    if (reply.kind !== 'review' && reply.findings.length > 0)
      context.addIssue({ code: 'custom', path: ['kind'], message: 'Findings require kind=review' });
    if (reply.simplification != null && reply.kind !== 'review')
      context.addIssue({
        code: 'custom',
        path: ['simplification'],
        message: 'Only a review may assess simplification',
      });
  });

/** A validated structured agent reply. */
export type Reply = z.infer<typeof agentReplySchema>;

const count = z.number().nullable();

/** Cumulative usage of one provider session. Unknown values stay null; billed cost is never known locally. */
export const usageSchema = z.object({
  scope: z.literal('provider-session-cumulative'),
  complete: z.boolean().exactOptional(),
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
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
});
export type TurnResult = z.infer<typeof turnResultSchema>;
