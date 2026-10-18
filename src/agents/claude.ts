import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { authorizeEditTool, editingInstructions } from '../edit-policy.js';
import { query, createSdkMcpServer, type AccountInfo, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeDeleteTool } from './claude-files.js';
import { claudeRepository, isRepositoryTool } from './claude-repository.js';
import { explorationInstructions } from '../repository-tools.js';
import { allowMcpTool, isExternalMcpTool, mcpInstructions, projectMcpServers } from '../integrations.js';
import { referenceInstructions } from '../reference-folders.js';
import { instructions, titleInstructions, replySchema, parseReply, subscriptionEnvironment, numeric, type AgentSession, type ConnectOptions, type TurnResult, type Usage } from './types.js';

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(value: SDKUserMessage): void { this.values.push(value); this.wake?.(); }
  close(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.ended) {
      const value = this.values.shift();
      if (value) yield value;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

export function hasClaudeSubscription(account: AccountInfo): boolean {
  // Current native SDK builds omit tokenSource even for authenticated Team accounts.
  const plan = /^(claude\s+)?(pro|max|team|enterprise)$/i.test(account.subscriptionType ?? '');
  return account.apiProvider === 'firstParty' && plan
    && (!account.tokenSource || account.tokenSource === 'claude.ai')
    && (!account.apiKeySource || account.apiKeySource === 'none');
}

export async function connectClaude(options: ConnectOptions): Promise<AgentSession> {
  options.signal.throwIfAborted();
  const session = new ClaudeSession(options);
  const abort = () => { void session.close().catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  try { await session.authenticate(); options.signal.throwIfAborted(); return session; }
  catch (error) { await session.close(); options.emit({ type: 'process.exit_confirmed', data: {} }); throw error; }
  finally { options.signal.removeEventListener('abort', abort); }
}

class ClaudeSession implements AgentSession {
  private readonly input = new InputQueue();
  private readonly sessionId: string;
  private readonly query: Query;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private active: { resolve: (result: TurnResult) => void; reject: (error: Error) => void } | null = null;
  private stopped = false;
  private stopRequested = false;
  private readonly consumption: Promise<void>;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: ConnectOptions) {
    this.sessionId = options.providerSessionId ?? randomUUID();
    const fileServer = options.editing?.policy.delete?.length ? createSdkMcpServer({
      name: 'grampus_files', version: '1.0.0', alwaysLoad: true, timeout: 5000,
      tools: [claudeDeleteTool(options.editing, options.emit, () => !!this.active && !this.stopRequested && !this.stopped && !this.closing)],
    }) : null;
    this.query = query({ prompt: this.input, options: {
      cwd: options.cwd, tools: options.purpose === 'title' ? [] : options.editing ? ['Read', 'Edit', 'Write', 'ToolSearch'] : ['ToolSearch'], permissionMode: 'default',
      mcpServers: options.purpose === 'title' ? {} : { ...projectMcpServers(options.configurationCwd ?? options.cwd, options.cwd), ...(fileServer ? { grampus_files: fileServer } : {}), ...(options.repository ? { grampus_repository: claudeRepository(options.repository, options.emit, () => !!this.active && !this.stopRequested && !this.stopped && !this.closing) } : {}) },
      strictMcpConfig: options.purpose === 'title', systemPrompt: options.purpose === 'title' ? titleInstructions : `${options.editing ? editingInstructions : instructions}\n${mcpInstructions}${options.repository ? `\n${explorationInstructions}\n${referenceInstructions(options.repository.references ?? [])}` : ''}`, outputFormat: { type: 'json_schema', schema: replySchema },
      maxTurns: options.purpose === 'title' ? 3 : 64, includePartialMessages: true,
      ...(options.editing ? { hooks: { PreToolUse: [{ hooks: [async input => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        if (options.repository && isRepositoryTool(input.tool_name)) return {};
        if (isExternalMcpTool(input.tool_name) || input.tool_name === 'ToolSearch') return {};
        const decision = authorizeEditTool(options.editing!, input.tool_name, input.tool_input, options.emit);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: decision.allowed ? 'allow' as const : 'deny' as const, permissionDecisionReason: decision.reason } };
      }] }] } } : {}),
      env: { ...subscriptionEnvironment(), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      canUseTool: async (name, input) => {
        if (options.purpose === 'title') return { behavior: 'deny', message: 'Task naming does not use tools' };
        if (allowMcpTool(name, options.emit, !!this.active && !this.stopRequested && !this.stopped && !this.closing)) return { behavior: 'allow' as const, updatedInput: input };
        if (options.repository && isRepositoryTool(name)) return { behavior: 'allow' as const, updatedInput: input };
        if (options.editing) {
          const decision = authorizeEditTool(options.editing, name, input, options.emit);
          if (decision.allowed) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: decision.reason };
        }
        return { behavior: 'deny', message: 'Grampus conversation sessions do not execute tools' };
      },
      ...(options.providerSessionId ? { resume: options.providerSessionId } : { sessionId: this.sessionId }),
      ...(options.model ? { model: options.model } : {}),
      ...(process.env.GRAMPUS_CLAUDE_COMMAND ? { pathToClaudeCodeExecutable: process.env.GRAMPUS_CLAUDE_COMMAND } : {}),
      spawnClaudeCodeProcess: config => {
        const child = spawn(config.command, config.args, {
          cwd: config.cwd, env: config.env, windowsHide: true, stdio: 'pipe', shell: false,
        });
        child.stderr.resume();
        this.child = child;
        this.exited = new Promise(resolve => child.once('close', () => resolve()));
        options.emit({ type: 'process.started', data: { pid: child.pid } });
        return child;
      },
    } });
    this.consumption = this.consume();
  }

  async authenticate(): Promise<void> {
    const account = await this.query.accountInfo();
    if (!hasClaudeSubscription(account)) {
      throw new Error('Claude requires an existing first-party Claude subscription login');
    }
    this.options.emit({ type: 'session.connected', data: { providerSessionId: this.sessionId, model: this.options.model, auth: 'subscription' } });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.message(message);
      if (this.active) throw new Error('Claude stream ended without a result');
    } catch (error) {
      this.active?.reject(error instanceof Error ? error : new Error(String(error)));
    } finally { this.active = null; this.stopped = true; }
  }

  private message(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      if (message.session_id !== this.sessionId) throw new Error('Claude resumed a different session');
      this.options.emit({ type: 'session.connected', data: { providerSessionId: message.session_id, model: message.model, auth: 'subscription' } });
      this.options.emit({ type: 'integrations.updated', data: { servers: message.mcp_servers.filter(server => !server.name.startsWith('grampus_')).map(server => ({ name: server.name, status: server.status })) } });
    }
    if (!this.active) return;
    if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
      this.options.emit({ type: 'output.delta', data: { text: message.event.delta.text } });
    }
    if (message.type !== 'result') return;
    const active = this.active;
    this.active = null;
    try {
      const usageValues = Object.values(message.modelUsage);
      const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens'): number | null =>
        usageValues.length && usageValues.every(value => numeric(value[key]) !== null)
          ? usageValues.reduce((total, value) => total + value[key], 0) : null;
      const usage: Usage = { scope: 'provider-session-cumulative', inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        cachedInputTokens: sum('cacheReadInputTokens'), estimatedCostUsd: numeric(message.total_cost_usd), billedCostUsd: null };
      this.options.emit({ type: 'usage.updated', data: usage });
      const status = this.stopRequested ? 'interrupted' : message.is_error || message.subtype !== 'success' ? 'failed' : 'completed';
      active.resolve({ status, reply: status === 'completed' && message.subtype === 'success'
        ? parseReply(message.structured_output ?? message.result) : null, usage,
      error: status === 'failed' ? ('errors' in message ? message.errors.join('; ') : 'Claude reported a failed result') : null });
    } catch (error) { active.reject(error instanceof Error ? error : new Error(String(error))); }
  }

  turn(prompt: string): Promise<TurnResult> {
    if (this.stopped || this.active) return Promise.reject(new Error('Claude session is unavailable or busy'));
    this.stopRequested = false;
    const result = new Promise<TurnResult>((resolve, reject) => { this.active = { resolve, reject }; });
    this.input.push({ type: 'user', session_id: this.sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: prompt } });
    this.options.emit({ type: 'turn.started', data: { providerTurnId: null } });
    return result.then(async output => {
      try {
        const servers = await this.query.mcpServerStatus();
        this.options.emit({ type: 'integrations.updated', data: { servers: servers.filter(server => !server.name.startsWith('grampus_')).map(server => ({ name: server.name, status: server.status })) } });
      } catch { /* Connection status is observational; retain the actual turn result. */ }
      return output;
    });
  }

  async interrupt(): Promise<void> {
    if (!this.active) return;
    this.stopRequested = true;
    await this.query.interrupt();
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.input.close();
    this.query.close();
    const force = setTimeout(() => this.child?.kill('SIGKILL'), 3000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Claude process shutdown unconfirmed')), 5000);
      })]);
      await this.consumption;
    } finally { clearTimeout(force); clearTimeout(deadline); }
  }
}
