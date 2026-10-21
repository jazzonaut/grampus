// Owns the provider contract shared by the Codex and Claude adapters: connection options, the agent
// session interface and validation of the structured reply every turn must return.
import type { ReasoningEffort } from '../domain/model-profiles.js';
import type { RepositoryAccess } from '../repository/repository-tools.js';
import type { EditingContext } from '../execution/edit-policy.js';
import type { DiagnosticSelection } from '../domain/diagnostics.js';
import { z } from 'zod';
import { BoundaryError, describeIssues, parseJson } from '../process/boundary.js';
import { agentReplySchema, type Reply, type TurnResult } from './reply-schema.js';

export { replyOutputSchema } from './reply-schema.js';
export type { Reply, TurnResult, Usage } from './reply-schema.js';

/** The agent providers Grampus can drive. */
export const providerSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof providerSchema>;
/**
 * Version of the tool set Grampus gives an agent, recorded on each session. Codex only receives its
 * dynamic repository tools on `thread/start`, so a Codex session recorded with another version is
 * continued in a fresh conversation instead. Bump it whenever the tool definitions change.
 */
export const agentToolsetVersion = 11;

/** System instructions for read-only conversation turns. Prompt text is a provider contract. */
export const instructions = `You are participating in a Grampus conversation. Do not edit files, run commands or delegate work. Use configured MCP integrations and the supplied read-only tools to gather task context.
Return the supplied JSON response format. Use kind=question for consequential missing information, putting each question in questions with a stable id, prompt and choices (empty allows free text). End the turn and wait for an answer. Do not use question tools.
Use kind=review for a requested independent review of supplied content; each finding needs concrete evidence. Account for controller-named earlier blockers in priorFindings with a resolved or unresolved status and concrete evidence. An empty findings list means no findings in the supplied content, not proof of repository validation. Otherwise use kind=message. Implementation messages may include findings as observations; these never establish independent review. Always include text, questions and findings; unused lists are empty and priorFindings is null outside review.`;

const replyHeadlines: Record<string, string> = {
  questions: 'Invalid questions',
  findings: 'Invalid review findings',
  kind: 'Reply kind does not match content',
  lenses: 'Invalid quality lens assessments',
};

/**
 * Validate a structured reply (an object, or the JSON text a provider returned) against
 * `agentReplySchema`. Failures are `BoundaryError`s of kind `agent-reply`, headed by the part of the
 * reply that is wrong (questions, findings, kind or lenses) and listing each field issue.
 */
export function parseReply(value: unknown): Reply {
  const context = { kind: 'agent-reply', source: 'structured reply' } as const;
  const reply = typeof value === 'string' ? parseJson(value, context) : value;
  const result = agentReplySchema.safeParse(reply);
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  const first = result.error.issues[0]?.path[0];
  const headline = (typeof first === 'string' ? replyHeadlines[first] : undefined) ?? 'Invalid structured reply';
  throw new BoundaryError(context, issues, `${headline}: ${issues.join('; ')}`, { cause: result.error });
}

/** A provider or tool event for the session journal. `data` is journaled as given. */
export interface AgentEvent {
  type: string;
  data: unknown;
}

/**
 * One connected provider conversation backed by an owned provider process. The adapter sends each
 * turn once and never retries it: a turn that may have reached the provider is never replayed.
 */
export interface AgentSession {
  /** Send one prompt and wait for its outcome. Rejects when busy, on transport failure or an invalid reply. */
  turn(prompt: string): Promise<TurnResult>;
  /**
   * Ask the provider to stop the active turn, which then settles as interrupted. May reject when the
   * provider cannot be asked yet (Codex before it acknowledged the turn); the caller then shuts down.
   */
  interrupt(): Promise<void>;
  /**
   * Stop the provider process. Resolves only once its exit is confirmed and rejects when it is not, so
   * the caller never reports an unconfirmed exit as settled.
   */
  close(): Promise<void>;
}

/** Everything an adapter needs to start or resume one provider conversation. */
export interface ConnectOptions {
  /** Controller-owned approved diagnostics; unavailable outside implementation. */
  commands?: { run: (name: string, selection?: DiagnosticSelection) => Promise<unknown>; readonly running?: boolean };
  /** Where project configuration (such as MCP servers) is read from when it differs from `cwd`. */
  configurationCwd?: string;
  /** Read-only repository tools to offer; absent means the agent gets none. */
  repository?: RepositoryAccess;
  /** Present only for implementation turns: the approved file policy native edits are checked against. */
  editing?: EditingContext;
  cwd: string;
  /** The provider conversation to resume, or null to start a new one. */
  providerSessionId: string | null;
  model: string | null;
  effort?: ReasoningEffort;
  /** Aborting it closes a connection still being set up; a connected session is stopped through its methods. */
  signal: AbortSignal;
  /** A property, not a method: adapters pass it on as a callback without binding. */
  emit: (event: AgentEvent) => void;
}

/**
 * Starts a connected session. When connecting fails, the adapter closes its process and journals
 * `process.exit_confirmed` before rethrowing, so the caller can tell a confirmed exit from an unknown one.
 */
export type Connector = (provider: Provider, options: ConnectOptions) => Promise<AgentSession>;

/**
 * The environment for provider processes, without API key and alternative backend variables. Grampus
 * runs providers only on the user's subscription login, so a key left in the environment must never
 * switch a provider to API billing or another backend.
 */
export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])
    delete env[key];
  return env;
}

/** A provider counter as a finite, non-negative number, or null (unknown) when it is anything else. */
export function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
