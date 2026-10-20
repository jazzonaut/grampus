// Owns bounded subscription observations from provider protocols. These are observations of account
// state, not a calculation of how much allowance this task consumed and never an execution gate.
import { z } from 'zod';
import type { AgentEvent } from './types.js';

const claude = z.object({
  rate_limit_info: z.object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
  }),
});
const window = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().optional(),
  resetsAt: z.number().optional(),
});
const codex = z.object({
  rateLimits: z.object({
    limitId: z.string().nullish(),
    limitName: z.string().nullish(),
    primary: window.nullish(),
    secondary: window.nullish(),
  }),
});

/** A Claude subscription observation validated against the pinned SDK's published message shape. */
export function claudeSubscription(value: unknown): AgentEvent | null {
  const parsed = claude.safeParse(value);
  return parsed.success
    ? { type: 'subscription.observed', data: { provider: 'claude', ...parsed.data.rate_limit_info } }
    : null;
}

/** A Codex account limit update, retaining its reported windows without attributing them to this run. */
export function codexSubscription(value: unknown): AgentEvent | null {
  const parsed = codex.safeParse(value);
  return parsed.success
    ? { type: 'subscription.observed', data: { provider: 'codex', ...parsed.data.rateLimits } }
    : null;
}
