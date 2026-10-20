// Owns the Claude adapter: one Agent SDK query per turn with Grampus' tool policy, hooks and MCP
// servers. Fields the controller relies on are validated by claude-protocol.ts before they are used.
import { modelAssignmentSchema } from '../domain/model-profiles.js';
import { claudeSubscription } from './subscription-limits.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { authorizeEditTool, editingInstructions, type EditingContext } from '../execution/edit-policy.js';
import { processLimits, repositoryToolLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { ClaudeActivity } from './activity.js';
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
import { claudeExecutable } from './executables.js';
import { claudeRepository, isRepositoryTool } from './claude-repository.js';
import { explorationInstructions } from '../repository/repository-tools.js';
import { claudeImplementation, isImplementationTool } from './claude-implementation.js';
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
  replyOutputSchema,
  parseReply,
  subscriptionEnvironment,
  numeric,
  type AgentSession,
  type ConnectOptions,
  type TurnResult,
  type Usage,
} from './types.js';

/** The SDK's streaming input: one query stays open and each turn pushes its prompt here once. */
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

/** Whether every token counter of a snapshot is zero or unknown, so it carries no measurement. */
function zeroCounters(usage: Usage): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens].every(
    value => !value,
  );
}

/**
 * True only for a first-party Claude subscription login (Pro, Max, Team or Enterprise) with no API key in
 * use. Anything else is refused before a turn is sent, so a turn never runs on API billing or through
 * another backend.
 */
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

/**
 * Connect a Claude session. `createQuery` is the SDK's `query`; replay tests substitute a recorded stream.
 * Rejects when the account report is malformed or not a subscription login, or the signal aborts; the
 * process is then closed and its exit journaled as confirmed. If that close cannot confirm the exit, its
 * error is thrown instead.
 */
export async function connectClaude(options: ConnectOptions, createQuery: typeof query = query): Promise<AgentSession> {
  options.signal.throwIfAborted();
  const session = new ClaudeSession(options, createQuery);
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
    // No decision here: canUseTool decides repository, external MCP and ToolSearch calls.
    if (options.repository && isRepositoryTool(input.tool_name)) return Promise.resolve({});
    if (options.commands && isImplementationTool(input.tool_name)) return Promise.resolve({});
    if (isExternalMcpTool(input.tool_name) || input.tool_name === 'ToolSearch') return Promise.resolve({});
    if (options.commands?.running && input.tool_name !== 'Read')
      return Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Wait for the active implementation command before editing',
        },
      });
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

/**
 * One Agent SDK query driven as a Grampus session. The query owns the Claude process; tool permission is
 * decided by `canUseTool` and, for editing turns, the PreToolUse hook, so file and external MCP tool
 * decisions are journaled before the tool can run. `doctor` constructs it directly to ask control
 * requests without a turn.
 */
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
  private readonly activity: ClaudeActivity;

  constructor(
    private readonly options: ConnectOptions,
    createQuery: typeof query = query,
  ) {
    modelAssignmentSchema.parse({
      provider: 'claude',
      model: options.model,
      ...(options.effort ? { effort: options.effort } : {}),
    });
    // A new conversation gets an id chosen here, so `system/init` can prove which session actually started.
    this.activity = new ClaudeActivity(options.emit);
    this.sessionId = options.providerSessionId ?? randomUUID();
    // Tools may act only for an active turn that is not stopping or closing.
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
    const executable = claudeExecutable();
    this.query = createQuery({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        // The only built-in tools; Claude never gets a shell. Deletion goes through grampus_files.
        tools: editing ? ['Read', 'Edit', 'Write', 'ToolSearch'] : ['ToolSearch'],
        permissionMode: 'default',
        mcpServers: {
          ...projectMcpServers(options.configurationCwd ?? options.cwd, options.cwd),
          ...(fileServer ? { grampus_files: fileServer } : {}),
          ...(options.repository
            ? {
                grampus_repository: claudeRepository(options.repository, options.emit, owned, error => {
                  this.stopRequested = true;
                  this.active?.reject(error);
                }),
              }
            : {}),
          ...(options.commands ? { grampus_implementation: claudeImplementation(options.commands, owned) } : {}),
        },
        // The user's own MCP configuration still loads natively alongside the servers passed here.
        strictMcpConfig: false,
        systemPrompt: `${editing ? editingInstructions : instructions}\n${mcpInstructions}${options.repository ? `\n${explorationInstructions}\n${referenceInstructions(options.repository.references ?? [])}` : ''}`,
        outputFormat: { type: 'json_schema', schema: replyOutputSchema },
        maxTurns: currentSettings().claudeMaxTurns,
        includePartialMessages: true,
        ...(editing ? { hooks: { PreToolUse: [{ hooks: [editingHook(options, editing)] }] } } : {}),
        // Subscription login only; background tasks are off so no agent work runs outside the turn.
        env: { ...subscriptionEnvironment(), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
        canUseTool: this.canUseTool(owned),
        ...(options.providerSessionId ? { resume: options.providerSessionId } : { sessionId: this.sessionId }),
        ...(options.model ? { model: options.model } : {}),
        ...claudeEffort(options.effort),
        // The same resolution doctor reports. An unresolved override is still passed, so the SDK fails on
        // it rather than silently using the bundled executable; a missing bundled one is the SDK's error.
        ...(executable.path || executable.source === 'environment'
          ? { pathToClaudeCodeExecutable: executable.command }
          : {}),
        // Grampus spawns the process itself (no shell) so it holds the child and can confirm its exit.
        spawnClaudeCodeProcess: config => {
          const child = spawn(config.command, config.args, {
            cwd: config.cwd,
            env: config.env,
            windowsHide: true,
            stdio: 'pipe',
            shell: false,
          });
          // Drained so a chatty stderr cannot fill the pipe and stall the child.
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

  /**
   * The permission callback the SDK consults when no hook has decided. External MCP tools and ToolSearch are
   * allowed only within an owned turn and are journaled first; repository tools check turn ownership
   * themselves; file tools go through the editing policy. Anything else is denied.
   */
  private canUseTool(owned: () => boolean): CanUseTool {
    const options = this.options;
    return (name, input) => {
      const decide = (): PermissionResult => {
        if (options.commands && isImplementationTool(name) && owned())
          return { behavior: 'allow', updatedInput: input };
        if (allowMcpTool(name, options.emit, owned())) return { behavior: 'allow', updatedInput: input };
        if (options.repository && isRepositoryTool(name)) return { behavior: 'allow', updatedInput: input };
        if (options.editing) {
          if (options.commands?.running && name !== 'Read')
            return { behavior: 'deny', message: 'Wait for the active implementation command before editing' };
          const decision = authorizeEditTool(options.editing, name, input, options.emit);
          if (decision.allowed) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: decision.reason };
        }
        return { behavior: 'deny', message: 'Grampus conversation sessions do not execute tools' };
      };
      return Promise.resolve(decide());
    };
  }

  /** The account the started executable reports. A control request: it never sends a turn. */
  async accountInfo(): Promise<ClaudeAccount> {
    return parseClaudeMessage('accountInfo', claudeAccountSchema, await this.query.accountInfo());
  }

  /** The local SDK's model catalogue. A control request: no prompt or inference is sent. */
  async supportedModels() {
    return this.query.supportedModels();
  }

  /** The MCP servers the executable loaded for this session, by name and status. */
  async mcpStatus(): Promise<{ name: string; status: string }[]> {
    return claudeMcpStatusSchema.parse(await this.query.mcpServerStatus());
  }

  /**
   * Refuse anything but a subscription login before any turn is sent.
   *
   * @throws Error when the executable reports another kind of account.
   */
  async authenticate(): Promise<void> {
    const account = await this.accountInfo();
    if (!hasClaudeSubscription(account)) {
      throw new Error('Claude requires an existing first-party Claude subscription login');
    }
    this.options.emit({
      type: 'session.connected',
      data: { providerSessionId: this.sessionId, model: this.options.model, auth: 'subscription' },
    });
  }

  /** Reads the whole message stream; any error or an early end fails the active turn. */
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

  /**
   * Sums the SDK's per-model cumulative counters into one snapshot. A model whose counter is missing
   * makes that total unknown rather than smaller.
   */
  private usageSnapshot(models: ClaudeModelUsage, cost: unknown, complete: boolean): Usage {
    const values = Object.values(models);
    const sum = (
      key: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens',
    ): number | null =>
      values.length && values.every(value => numeric(value[key]) !== null)
        ? values.reduce((total, value) => total + (numeric(value[key]) ?? 0), 0)
        : null;
    return {
      scope: 'provider-session-cumulative',
      complete,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cachedInputTokens: sum('cacheReadInputTokens'),
      cacheWriteInputTokens: sum('cacheCreationInputTokens'),
      estimatedCostUsd: numeric(cost),
      billedCostUsd: null,
    };
  }

  private publishUsage(models: ClaudeModelUsage, cost: unknown, complete: boolean): Usage {
    const usage = this.usageSnapshot(models, cost, complete);
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
    // This id is recorded as the provider conversation, so a different one (new or resumed) is refused.
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
    // Messages inside a nested tool use do not describe the main conversation's context size.
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
    // Unknown types are reported once per type, only while a turn is active, and otherwise ignored.
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
    this.activity.message(type, message);
    if (message.type === 'rate_limit_event') {
      const observation = claudeSubscription(message);
      if (observation) this.options.emit(observation);
    }
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
      const status = this.stopRequested
        ? 'interrupted'
        : result.is_error || result.subtype !== 'success'
          ? 'failed'
          : 'completed';
      // The SDK documents that crash and startup-error results may carry zeroed counters. Zero is not
      // a measurement there, so the result reports no usage and earlier samples stay partial.
      const zeroed =
        (result.is_error || result.subtype !== 'success') &&
        zeroCounters(this.usageSnapshot(result.modelUsage, result.total_cost_usd, true));
      const usage = zeroed ? null : this.publishUsage(result.modelUsage, result.total_cost_usd, true);
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

  /**
   * Push one prompt into the open query. It is sent exactly once; a failure is reported, never resent.
   * Rejects at once when the stream has ended or a turn is already active.
   */
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

  /** Ask the SDK to interrupt; the result that follows is reported as interrupted whatever it says. */
  async interrupt(): Promise<void> {
    if (!this.active) return;
    this.stopRequested = true;
    await this.query.interrupt();
  }

  /** Idempotent: every caller waits for the same shutdown. */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  /**
   * Ends the input and the query, kills the child after `claudeKillMs` and waits for it to close.
   * Rejects with `Claude process shutdown unconfirmed` when no close is seen within `claudeShutdownMs`.
   */
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

/** Maps only supported effort values into the SDK's options. */
function claudeEffort(effort: ConnectOptions['effort']) {
  if (!effort || effort === 'none' || effort === 'minimal') return {};
  return { effort };
}
