// Owns the Claude adapter: one Agent SDK query per turn with Grampus' tool policy, hooks and MCP
// servers. Fields the controller relies on are validated by claude-protocol.ts before they are used.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { authorizeEditTool, editingInstructions, type EditingContext } from '../execution/edit-policy.js';
import { processLimits, providerLimits, repositoryToolLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import {
  query,
  createSdkMcpServer,
  type HookCallback,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { UnrecognizedMessages, boundedExcerpt, describeIssues, protocolDiagnostic } from '../process/boundary.js';
import { claudeDeleteTool } from './claude-files.js';
import { claudeRepository, isRepositoryTool } from './claude-repository.js';
import { explorationInstructions } from '../repository/repository-tools.js';
import { allowMcpTool, isExternalMcpTool, mcpInstructions, projectMcpServers } from './integrations.js';
import { referenceInstructions } from '../repository/reference-folders.js';
import {
  claudeAccountSchema,
  claudeAssistantUsageSchema,
  claudeInitSchema,
  claudeMcpStatusSchema,
  claudeResultSchema,
  claudeTextDeltaSchema,
  claudeUsageSampleSchema,
  isKnownClaudeMessageType,
  parseClaudeMessage,
  type ClaudeAccount,
  type ClaudeModelUsage,
} from './claude-protocol.js';
import {
  instructions,
  titleInstructions,
  replyOutputSchema,
  parseReply,
  subscriptionEnvironment,
  numeric,
  type AgentSession,
  type ConnectOptions,
  type TurnResult,
  type Usage,
} from './types.js';

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(value: SDKUserMessage): void {
    this.values.push(value);
    this.wake?.();
  }
  close(): void {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.ended) {
      const value = this.values.shift();
      if (value) yield value;
      else
        await new Promise<void>(resolve => {
          this.wake = resolve;
        });
    }
  }
}

export function hasClaudeSubscription(account: ClaudeAccount): boolean {
  // Current native SDK builds omit tokenSource even for authenticated Team accounts.
  const plan = /^(claude\s+)?(pro|max|team|enterprise)$/i.test(account.subscriptionType ?? '');
  return (
    account.apiProvider === 'firstParty' &&
    plan &&
    (!account.tokenSource || account.tokenSource === 'claude.ai') &&
    (!account.apiKeySource || account.apiKeySource === 'none')
  );
}

export async function connectClaude(options: ConnectOptions): Promise<AgentSession> {
  options.signal.throwIfAborted();
  const session = new ClaudeSession(options);
  const abort = () => {
    void session.close().catch(() => {});
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await session.authenticate();
    options.signal.throwIfAborted();
    return session;
  } catch (error) {
    await session.close();
    options.emit({ type: 'process.exit_confirmed', data: {} });
    throw error;
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}

/** PreToolUse hook for editing turns: every native file tool decision is journaled before it runs. */
function editingHook(options: ConnectOptions, editing: EditingContext): HookCallback {
  return input => {
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    if (options.repository && isRepositoryTool(input.tool_name)) return Promise.resolve({});
    if (isExternalMcpTool(input.tool_name) || input.tool_name === 'ToolSearch') return Promise.resolve({});
    const decision = authorizeEditTool(editing, input.tool_name, input.tool_input, options.emit);
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: decision.allowed ? ('allow' as const) : ('deny' as const),
        permissionDecisionReason: decision.reason,
      },
    });
  };
}

export class ClaudeSession implements AgentSession {
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
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private samplingUsage = false;
  private lastUsage = '';
  private readonly unrecognized = new UnrecognizedMessages();

  constructor(
    private readonly options: ConnectOptions,
    createQuery: typeof query = query,
  ) {
    this.sessionId = options.providerSessionId ?? randomUUID();
    const owned = () => !!this.active && !this.stopRequested && !this.stopped && !this.closing;
    const editing = options.editing;
    const fileServer = editing?.policy.delete?.length
      ? createSdkMcpServer({
          name: 'grampus_files',
          version: '1.0.0',
          alwaysLoad: true,
          timeout: repositoryToolLimits.deleteToolTimeoutMs,
          tools: [claudeDeleteTool(editing, options.emit, owned)],
        })
      : null;
    const title = options.purpose === 'title';
    this.query = createQuery({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        tools: title ? [] : editing ? ['Read', 'Edit', 'Write', 'ToolSearch'] : ['ToolSearch'],
        permissionMode: 'default',
        mcpServers: title
          ? {}
          : {
              ...projectMcpServers(options.configurationCwd ?? options.cwd, options.cwd),
              ...(fileServer ? { grampus_files: fileServer } : {}),
              ...(options.repository
                ? { grampus_repository: claudeRepository(options.repository, options.emit, owned) }
                : {}),
            },
        strictMcpConfig: title,
        systemPrompt: title
          ? titleInstructions
          : `${editing ? editingInstructions : instructions}\n${mcpInstructions}${options.repository ? `\n${explorationInstructions}\n${referenceInstructions(options.repository.references ?? [])}` : ''}`,
        outputFormat: { type: 'json_schema', schema: replyOutputSchema },
        maxTurns: title ? providerLimits.claudeTitleMaxTurns : providerLimits.claudeMaxTurns,
        includePartialMessages: true,
        ...(editing ? { hooks: { PreToolUse: [{ hooks: [editingHook(options, editing)] }] } } : {}),
        env: { ...subscriptionEnvironment(), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
        canUseTool: this.canUseTool(owned),
        ...(options.providerSessionId ? { resume: options.providerSessionId } : { sessionId: this.sessionId }),
        ...(options.model ? { model: options.model } : {}),
        ...(process.env.GRAMPUS_CLAUDE_COMMAND
          ? { pathToClaudeCodeExecutable: process.env.GRAMPUS_CLAUDE_COMMAND }
          : {}),
        spawnClaudeCodeProcess: config => {
          const child = spawn(config.command, config.args, {
            cwd: config.cwd,
            env: config.env,
            windowsHide: true,
            stdio: 'pipe',
            shell: false,
          });
          child.stderr.resume();
          this.child = child;
          this.exited = new Promise(resolve => child.once('close', () => resolve()));
          options.emit({ type: 'process.started', data: { pid: child.pid } });
          return child;
        },
      },
    });
    this.consumption = this.consume();
  }

  private canUseTool(owned: () => boolean): CanUseTool {
    const options = this.options;
    return (name, input) => {
      const decide = (): PermissionResult => {
        if (options.purpose === 'title') return { behavior: 'deny', message: 'Task naming does not use tools' };
        if (allowMcpTool(name, options.emit, owned())) return { behavior: 'allow', updatedInput: input };
        if (options.repository && isRepositoryTool(name)) return { behavior: 'allow', updatedInput: input };
        if (options.editing) {
          const decision = authorizeEditTool(options.editing, name, input, options.emit);
          if (decision.allowed) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: decision.reason };
        }
        return { behavior: 'deny', message: 'Grampus conversation sessions do not execute tools' };
      };
      return Promise.resolve(decide());
    };
  }

  async authenticate(): Promise<void> {
    const account = parseClaudeMessage('accountInfo', claudeAccountSchema, await this.query.accountInfo());
    if (!hasClaudeSubscription(account)) {
      throw new Error('Claude requires an existing first-party Claude subscription login');
    }
    this.options.emit({
      type: 'session.connected',
      data: { providerSessionId: this.sessionId, model: this.options.model, auth: 'subscription' },
    });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.message(message);
      if (this.active) throw new Error('Claude stream ended without a result');
    } catch (error) {
      this.active?.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearInterval(this.usageTimer);
      this.active = null;
      this.stopped = true;
    }
  }

  private publishUsage(models: ClaudeModelUsage, cost: unknown, complete: boolean): Usage {
    const values = Object.values(models);
    const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens'): number | null =>
      values.length && values.every(value => numeric(value[key]) !== null)
        ? values.reduce((total, value) => total + (numeric(value[key]) ?? 0), 0)
        : null;
    const usage: Usage = {
      scope: 'provider-session-cumulative',
      complete,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cachedInputTokens: sum('cacheReadInputTokens'),
      estimatedCostUsd: numeric(cost),
      billedCostUsd: null,
    };
    const serialized = JSON.stringify(usage);
    if (serialized !== this.lastUsage) {
      this.options.emit({ type: 'usage.updated', data: usage });
      this.lastUsage = serialized;
    }
    return usage;
  }

  private async sampleUsage(): Promise<void> {
    if (this.samplingUsage || !this.active || this.closing || this.stopped) return;
    const active = this.active;
    this.samplingUsage = true;
    try {
      const report = claudeUsageSampleSchema.parse(
        await this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      );
      if (this.active === active && !this.closing && !this.stopped)
        this.publishUsage(report.session.model_usage, report.session.total_cost_usd, false);
    } catch {
      /* Usage availability never interrupts an agent turn. Final results remain authoritative. */
    } finally {
      this.samplingUsage = false;
    }
  }

  private integrations(servers: { name: string; status: string }[]): void {
    this.options.emit({
      type: 'integrations.updated',
      data: {
        servers: servers
          .filter(server => !server.name.startsWith('grampus_'))
          .map(server => ({ name: server.name, status: server.status })),
      },
    });
  }

  private initialised(message: SDKMessage): void {
    const init = parseClaudeMessage('system/init', claudeInitSchema, message);
    if (init.session_id !== this.sessionId) throw new Error('Claude resumed a different session');
    this.options.emit({
      type: 'session.connected',
      data: { providerSessionId: init.session_id, model: init.model, auth: 'subscription' },
    });
    this.integrations(init.mcp_servers);
  }

  private assistantUsage(message: SDKMessage): void {
    const parsed = claudeAssistantUsageSchema.safeParse(message);
    if (!parsed.success) {
      this.options.emit(
        protocolDiagnostic('protocol.malformed', {
          provider: 'claude',
          messageType: 'assistant',
          excerpt: boundedExcerpt({ keys: Object.keys(message) }),
          issues: describeIssues(parsed.error),
        }),
      );
      return;
    }
    if (parsed.data.parent_tool_use_id) return;
    const usage = parsed.data.message.usage;
    const inputTokens = numeric(usage.input_tokens),
      cached = numeric(usage.cache_read_input_tokens),
      created = numeric(usage.cache_creation_input_tokens);
    if (inputTokens !== null)
      this.options.emit({
        type: 'context.updated',
        data: { inputTokens: inputTokens + (cached ?? 0) + (created ?? 0) },
      });
  }

  private message(message: SDKMessage): void {
    const type: string = message.type;
    if (!isKnownClaudeMessageType(type)) {
      if (this.active && this.unrecognized.report(type))
        this.options.emit(
          protocolDiagnostic('protocol.unrecognized', {
            provider: 'claude',
            messageType: type,
            excerpt: boundedExcerpt(message),
          }),
        );
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') this.initialised(message);
    if (!this.active) return;
    if (message.type === 'assistant') this.assistantUsage(message);
    if (message.type === 'stream_event') {
      const delta = claudeTextDeltaSchema.safeParse(message);
      if (delta.success) this.options.emit({ type: 'output.delta', data: { text: delta.data.event.delta.text } });
    }
    if (message.type === 'result') this.finish(this.active, message);
  }

  private finish(active: NonNullable<ClaudeSession['active']>, message: SDKMessage): void {
    this.active = null;
    clearInterval(this.usageTimer);
    try {
      const result = parseClaudeMessage('result', claudeResultSchema, message);
      const usage = this.publishUsage(result.modelUsage, result.total_cost_usd, true);
      const status = this.stopRequested
        ? 'interrupted'
        : result.is_error || result.subtype !== 'success'
          ? 'failed'
          : 'completed';
      active.resolve({
        status,
        reply: status === 'completed' ? parseReply(result.structured_output ?? result.result) : null,
        usage,
        error:
          status === 'failed' ? (result.errors ? result.errors.join('; ') : 'Claude reported a failed result') : null,
      });
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  turn(prompt: string): Promise<TurnResult> {
    if (this.stopped || this.active) return Promise.reject(new Error('Claude session is unavailable or busy'));
    this.stopRequested = false;
    const result = new Promise<TurnResult>((resolve, reject) => {
      this.active = { resolve, reject };
    });
    this.usageTimer = setInterval(() => {
      void this.sampleUsage();
    }, currentSettings().usagePollIntervalMs);
    this.input.push({
      type: 'user',
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: prompt },
    });
    this.options.emit({ type: 'turn.started', data: { providerTurnId: null } });
    return result.then(async output => {
      try {
        this.integrations(claudeMcpStatusSchema.parse(await this.query.mcpServerStatus()));
      } catch {
        /* Connection status is observational; retain the actual turn result. */
      }
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
    clearInterval(this.usageTimer);
    this.input.close();
    this.query.close();
    const force = setTimeout(() => this.child?.kill('SIGKILL'), processLimits.claudeKillMs);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Claude process shutdown unconfirmed')),
            processLimits.claudeShutdownMs,
          );
        }),
      ]);
      await this.consumption;
    } finally {
      clearTimeout(force);
      clearTimeout(deadline);
    }
  }
}
