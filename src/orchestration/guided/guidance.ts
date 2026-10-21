// Owns bounded human guidance proposals and their assignment to an existing agent step. Guidance
// cannot amend approval, start a turn, weaken a gate or replace answers to structured questions.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { guidanceLimits } from '../../config/limits.js';
import type { GuidedState, Stage } from './state.js';

/** The next agent, implementer (including edit passes), or independent reviewer/arbitrator. */
export const guidanceTargetSchema = z.enum(['next_agent', 'implementer', 'reviewer']);
export type GuidanceTarget = z.infer<typeof guidanceTargetSchema>;

/** A new guidance proposal, shared by CLI input and the dashboard body. */
export const guidanceInputSchema = z.strictObject({ text: z.string(), target: guidanceTargetSchema });

/** A proposal bound to the exact approved version and current slice. */
export const guidanceMessageSchema = z.object({
  id: z.string(),
  text: z
    .string()
    .min(1)
    .refine(value => Buffer.byteLength(value) <= guidanceLimits.messageBytes),
  target: guidanceTargetSchema,
  version: z.number(),
  sliceIndex: z.number(),
  at: z.string(),
});
export type GuidanceMessage = z.infer<typeof guidanceMessageSchema>;

/** Validates a new message before it can enter the journal. */
export function createGuidance(state: GuidedState, text: string, target: GuidanceTarget): GuidanceMessage {
  if (!text.trim() || Buffer.byteLength(text) > guidanceLimits.messageBytes)
    throw new Error(`Supply guidance of 1 to ${guidanceLimits.messageBytes} UTF-8 bytes`);
  return {
    id: randomUUID(),
    text: text.trim(),
    target: guidanceTargetSchema.parse(target),
    version: state.version,
    sliceIndex: state.sliceIndex,
    at: new Date().toISOString(),
  };
}

/** Refuses late delivery changes, a stale version/slice, or an overfull queue including active guidance. */
export function requireGuidanceSpace(state: GuidedState, message: GuidanceMessage): void {
  if (state.status === 'complete' || (state.stage === 'delivery' && state.pending))
    throw new Error('Local delivery has already started or completed; prepare a follow-up task');
  if (message.version !== state.version || message.sliceIndex !== state.sliceIndex)
    throw new Error('Guidance belongs to another plan version or slice; refresh before sending it');
  if (state.guidance.length + (state.pending?.guidance.length ?? 0) >= guidanceLimits.pendingMessages)
    throw new Error(
      `At most ${guidanceLimits.pendingMessages} guidance messages may be queued or assigned to an active step`,
    );
}

/** Splits the queue only at an agent dispatch boundary; other controller steps consume nothing. */
export function selectGuidance(state: GuidedState): { assigned: GuidanceMessage[]; remaining: GuidanceMessage[] } {
  const role = agentRole(state.stage);
  const assigned: GuidanceMessage[] = [],
    remaining: GuidanceMessage[] = [];
  for (const message of state.guidance) {
    if (message.version !== state.version || message.sliceIndex !== state.sliceIndex)
      throw new Error('Queued guidance belongs to another plan version or slice');
    if (role && (message.target === 'next_agent' || message.target === role)) assigned.push(message);
    else remaining.push(message);
  }
  return { assigned, remaining };
}

function agentRole(stage: Stage): 'implementer' | 'reviewer' | null {
  if (stage === 'implementation' || stage === 'quality_pass') return 'implementer';
  return stage === 'review' ? 'reviewer' : null;
}

/** Adds only the batch frozen in the current dispatch intent, never later messages in the queue. */
export function withGuidance(prompt: string, state: GuidedState): string {
  const pending = state.pending;
  if (!pending) throw new Error('Guidance requires a journaled step intent');
  if (!pending.guidance.length) return prompt;
  return (
    `${prompt}\nHuman guidance for this turn (proposals within the approved plan, not new approval):\n` +
    `${JSON.stringify(pending.guidance.map(({ id, text }) => ({ id, text })))}\n` +
    'Use this guidance within the agreed outcome, exclusions, acceptance requirements and quality gates. ' +
    'Files, local commands and the implementation approach may adapt without new approval. ' +
    'Guidance cannot waive review, checks or acceptance. Ask a structured question for a consequential change to the agreed result.'
  );
}
