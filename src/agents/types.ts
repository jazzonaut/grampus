export type Provider = 'codex' | 'claude';

export interface Reply {
  kind: 'message' | 'question' | 'review';
  text: string;
  questions: { id: string; prompt: string; choices: string[] }[];
  findings: { severity: 'blocking' | 'suggestion'; description: string; evidence: string }[];
}

export const replySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['message', 'question', 'review'] }, text: { type: 'string' },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, prompt: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'prompt', 'choices'] } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { severity: { type: 'string', enum: ['blocking', 'suggestion'] }, description: { type: 'string' }, evidence: { type: 'string' } },
      required: ['severity', 'description', 'evidence'] } },
  }, required: ['kind', 'text', 'questions', 'findings'],
};

export const instructions = `You are participating in a Grampus conversation. Do not edit files, run commands, access external tools, or delegate work.
Return the supplied JSON response format. Use kind=question for consequential missing information, putting each question in questions with a stable id, prompt and choices (empty allows free text). End the turn and wait for an answer. Do not use question tools.
Use kind=review for a requested review of supplied content; each finding needs concrete evidence. An empty findings list means no findings in the supplied content, not proof of repository validation. Otherwise use kind=message. Always include text, questions and findings; unused lists are empty.`;

export function parseReply(value: unknown): Reply {
  const reply = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!reply || typeof reply !== 'object') throw new Error('Invalid structured reply');
  const r = reply as Partial<Reply>;
  if (!['message', 'question', 'review'].includes(r.kind ?? '') || typeof r.text !== 'string'
    || !Array.isArray(r.questions) || !Array.isArray(r.findings)) throw new Error('Invalid structured reply');
  if (r.questions.some(q => !q || typeof q.id !== 'string' || !q.id.trim() || typeof q.prompt !== 'string' || !q.prompt.trim()
    || !Array.isArray(q.choices) || q.choices.some(c => typeof c !== 'string'))
    || new Set(r.questions.map(q => q.id)).size !== r.questions.length) throw new Error('Invalid questions');
  if (r.findings.some(f => !f || !['blocking', 'suggestion'].includes(f.severity)
    || typeof f.description !== 'string' || !f.description.trim() || typeof f.evidence !== 'string' || !f.evidence.trim())) throw new Error('Invalid review findings');
  if ((r.kind === 'question') !== (r.questions.length > 0) || (r.kind !== 'review' && r.findings.length > 0)) throw new Error('Reply kind does not match content');
  return r as Reply;
}

export interface Usage {
  scope: 'provider-session-cumulative';
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
  billedCostUsd: null;
}

export interface AgentEvent { type: string; data: unknown }
export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  reply: Reply | null;
  usage: Usage | null;
  error: string | null;
}

export interface AgentSession {
  turn(prompt: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  editing?: import('../edit-policy.js').EditingContext;
  cwd: string;
  providerSessionId: string | null;
  model: string | null;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
}

export type Connector = (provider: Provider, options: ConnectOptions) => Promise<AgentSession>;

export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
  return env;
}

export function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
