// Owns the Codex adapter: one `codex app-server` process per turn, thread start or resume, turns,
// controller-approved native patches and the dynamic repository tools. Protocol shapes are pinned in
// codex-protocol.ts; this module only acts on messages that module has validated.
import { RpcProcess, type RpcMessage } from '../process/process.js';
import { providerLimits } from '../config/limits.js';
import { applicationVersion } from '../config/runtime.js';
import { UnrecognizedMessages, protocolDiagnostic, boundedExcerpt } from '../process/boundary.js';
import { mcpInstructions } from './integrations.js';
import { codexExecutable } from './executables.js';
import { referenceInstructions } from '../repository/reference-folders.js';
import {
  repositoryTools,
  repositoryToolDefinitions,
  explorationInstructions,
  type RepositoryAccess,
} from '../repository/repository-tools.js';
import { authorizeFileChanges, implementationInstructions, type EditingContext } from '../execution/edit-policy.js';
import {
  accountReadSchema,
  agentMessageText,
  classifyCodexNotification,
  configReadSchema,
  fileChangeItem,
  isKnownCodexNotification,
  itemId,
  mcpStatusPageSchema,
  notificationThread,
  parseCodexResponse,
  patchApprovalRequestSchema,
  readOnlySandboxSchema,
  threadStartSchema,
  toolCallRequestSchema,
  turnStartSchema,
  type CodexNotification,
  type McpStatusPage,
} from './codex-protocol.js';
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
import { z } from 'zod';

/**
 * Every configured MCP server's status, page by page up to `providerLimits.mcpStatusTotal`. With a thread
 * the thread's own connections are reported; `doctor` passes null to ask without starting a thread.
 */
export async function listCodexMcpServers(
  rpc: RpcProcess,
  threadId: string | null,
): Promise<{ name: string; status: string; tools: number; auth: string }[]> {
  const servers: { name: string; status: string; tools: number; auth: string }[] = [];
  let cursor: string | null = null;
  do {
    const page: McpStatusPage = parseCodexResponse(
      'mcpServerStatus/list',
      mcpStatusPageSchema,
      await rpc.request('mcpServerStatus/list', {
        threadId,
        detail: 'toolsAndAuthOnly',
        limit: providerLimits.mcpStatusPage,
        cursor,
      }),
    );
    servers.push(
      ...page.data.map(item => ({
        name: item.name,
        status: item.runtimeStatus ?? 'configured',
        tools: Object.keys(item.tools ?? {}).length,
        auth: item.authStatus ?? 'unknown',
      })),
    );
    cursor = page.nextCursor;
  } while (cursor && servers.length < providerLimits.mcpStatusTotal);
  return servers;
}

async function reportIntegrations(rpc: RpcProcess, threadId: string, emit: ConnectOptions['emit']) {
  try {
    const servers = await listCodexMcpServers(rpc, threadId);
    emit({ type: 'integrations.updated', data: { servers } });
  } catch {
    emit({
      type: 'integrations.updated',
      data: {
        servers: [{ name: 'Configured MCP servers', status: 'Status unavailable; provider tools remain enabled' }],
      },
    });
  }
}

/** config/read materializes optional fields as null; TOML overrides cannot represent null. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === null ? [] : [[key, withoutNulls(item)]])),
  );
}

const mcpServerSchema = z.looseObject({ enabled: z.unknown().optional() });

async function mcpOverrides(rpc: RpcProcess, options: ConnectOptions): Promise<Record<string, unknown>> {
  const overrides: Record<string, unknown> = { web_search: 'disabled' };
  const effective = parseCodexResponse(
    'config/read',
    configReadSchema,
    await rpc.request('config/read', { includeLayers: false, cwd: options.configurationCwd ?? options.cwd }),
  );
  for (const [name, server] of Object.entries(effective.config.mcp_servers ?? {})) {
    const configured = withoutNulls(server);
    overrides[`mcp_servers.${name}`] = {
      ...(configured && typeof configured === 'object' ? configured : {}),
      enabled: options.purpose !== 'title' && mcpServerSchema.parse(server).enabled !== false,
    };
  }
  return overrides;
}

function developerInstructions(options: ConnectOptions): string {
  let text =
    options.purpose === 'title'
      ? titleInstructions
      : options.editing
        ? implementationInstructions(
            'Use only apply_patch to update approved existing files, add explicitly authorized new files or delete explicitly authorized unchanged files, using their supplied contents. Deferred entries must be read with grampus_read_file before editing; null without deferred means absent. Parent directories must already exist. Deletion paths cannot be updated or recreated. Do not move files or delete directories. Each patch requires controller approval.',
          )
        : instructions;
  if (options.purpose !== 'title') text += `\n${mcpInstructions}`;
  if (options.repository)
    text += `\n${explorationInstructions}\n${referenceInstructions(options.repository.references ?? [])}`;
  return text;
}

/** Features disabled on every Grampus app-server: no shell, hooks, delegation or other side channels. */
const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'hooks',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'goals',
  'code_mode',
];

/** The exact `codex app-server` arguments of every Grampus connection; `doctor` uses them unchanged. */
export function codexAppServerArguments(): string[] {
  return [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'forced_login_method="chatgpt"',
    ...disabledFeatures.flatMap(feature => ['--disable', feature]),
  ];
}

/** Start the resolved Codex executable as an app-server in `cwd`, with API keys removed from its environment. */
export function startCodexAppServer(cwd: string): RpcProcess {
  return new RpcProcess(codexExecutable().command, codexAppServerArguments(), { cwd, env: subscriptionEnvironment() });
}

/** What the app-server reported during the handshake, before any thread exists. */
export interface CodexHandshake {
  account: z.output<typeof accountReadSchema>['account'];
}

/**
 * The connection handshake: `initialize` with the capabilities Grampus relies on (the experimental API,
 * needed for dynamic tools and the approvals reviewer), `initialized`, then `account/read` without a
 * token refresh. No thread or turn is started, so the handshake never causes inference.
 */
export async function codexHandshake(rpc: RpcProcess): Promise<CodexHandshake> {
  await rpc.request('initialize', {
    clientInfo: { name: 'grampus', title: 'Grampus', version: applicationVersion },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');
  const auth = parseCodexResponse(
    'account/read',
    accountReadSchema,
    await rpc.request('account/read', { refreshToken: false }),
  );
  return { account: auth.account };
}

/** True when the handshake shows the ChatGPT subscription login every Codex turn requires. */
export function hasCodexSubscription(handshake: CodexHandshake): boolean {
  return handshake.account?.type === 'chatgpt';
}

/** Connect a Codex session. `start` creates the app-server process; replay tests substitute a recorded server. */
export async function connectCodex(
  options: ConnectOptions,
  start: (cwd: string) => RpcProcess = startCodexAppServer,
): Promise<AgentSession> {
  options.signal.throwIfAborted();
  const rpc = start(options.cwd);
  const abort = () => {
    void rpc.close().catch(() => {});
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.emit({ type: 'process.started', data: { pid: rpc.pid } });
    const auth = await codexHandshake(rpc);
    if (!hasCodexSubscription(auth)) throw new Error('Codex requires an existing ChatGPT subscription login');
    const params = {
      cwd: options.cwd,
      modelProvider: 'openai',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: developerInstructions(options),
      config: await mcpOverrides(rpc, options),
      ...(options.editing ? { approvalsReviewer: 'user' } : {}),
      ...(options.repository && !options.providerSessionId
        ? { dynamicTools: repositoryToolDefinitions.map(tool => ({ type: 'function', ...tool })) }
        : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    const method = options.providerSessionId ? 'thread/resume' : 'thread/start';
    const thread = parseCodexResponse(
      method,
      threadStartSchema,
      await rpc.request(
        method,
        options.providerSessionId ? { ...params, threadId: options.providerSessionId } : params,
      ),
    );
    if (options.providerSessionId && thread.thread.id !== options.providerSessionId)
      throw new Error('Codex resumed a different session');
    const sandbox = readOnlySandboxSchema.safeParse(thread.sandbox);
    if (
      options.editing &&
      (thread.approvalPolicy !== 'untrusted' ||
        thread.approvalsReviewer !== 'user' ||
        !sandbox.success ||
        sandbox.data.networkAccess === true)
    )
      throw new Error('Codex did not confirm controller approvals and read-only sandbox');
    options.emit({
      type: 'session.connected',
      data: { providerSessionId: thread.thread.id, model: thread.model, auth: 'subscription' },
    });
    if (options.purpose !== 'title') await reportIntegrations(rpc, thread.thread.id, options.emit);
    options.signal.throwIfAborted();
    return new CodexSession(rpc, thread.thread.id, options.emit, options.editing, options.repository);
  } catch (error) {
    await rpc.close();
    options.emit({ type: 'process.exit_confirmed', data: {} });
    throw error;
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}

interface ActiveTurn {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  turnId: string | null;
  text: string;
  usage: Usage | null;
  patches: Map<string, unknown>;
  seenItems: Set<string>;
  toolCalls: Set<string>;
  stopping: boolean;
}

const patchOwnershipSchema = z.looseObject({ threadId: z.string(), turnId: z.string(), itemId: z.string() });

export class CodexSession implements AgentSession {
  private active: ActiveTurn | null = null;
  private readonly unsubscribe: (() => void)[];
  private readonly readRepository: ReturnType<typeof repositoryTools> | undefined;
  private readonly unrecognized = new UnrecognizedMessages();

  constructor(
    private readonly rpc: RpcProcess,
    private readonly threadId: string,
    private readonly emit: ConnectOptions['emit'],
    private readonly editing?: EditingContext,
    repository?: RepositoryAccess,
  ) {
    this.readRepository = repository
      ? repositoryTools(repository, emit, () => !!this.active && !this.active.stopping)
      : undefined;
    this.unsubscribe = [
      rpc.onMessage(message => this.message(message)),
      rpc.onFailure(error => {
        this.active?.reject(error);
        this.active = null;
      }),
      rpc.onRequest(message => this.approve(message)),
    ];
  }

  private callTool(params: unknown): unknown {
    const active = this.active;
    try {
      const call = toolCallRequestSchema.safeParse(params);
      if (
        !this.readRepository ||
        !active ||
        active.stopping ||
        active.turnId === null ||
        !call.success ||
        call.data.threadId !== this.threadId ||
        call.data.turnId !== active.turnId
      )
        throw new Error('Repository tool call lacks current turn ownership');
      const callKey = `tool:${call.data.callId}`;
      if (active.toolCalls.has(callKey) || active.toolCalls.size >= providerLimits.turnToolCalls)
        throw new Error('Duplicate repository tool call or turn tool limit exceeded');
      active.toolCalls.add(callKey);
      const result = this.readRepository(call.data.tool, call.data.arguments);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  private approvePatch(editing: EditingContext, params: unknown): unknown {
    const active = this.active;
    const owned = patchOwnershipSchema.safeParse(params);
    const matches =
      active &&
      !active.stopping &&
      active.turnId !== null &&
      owned.success &&
      owned.data.threadId === this.threadId &&
      owned.data.turnId === active.turnId;
    const changes = matches ? active.patches.get(owned.data.itemId) : undefined;
    if (matches) active.patches.delete(owned.data.itemId); // One decision per item, including denials.
    // Strict: grantRoot or any unknown field would ask for more than this one patch.
    if (changes && patchApprovalRequestSchema.safeParse(params).success)
      return { decision: authorizeFileChanges(editing, changes, this.emit) ? 'accept' : 'decline' };
    this.emit({
      type: 'tool.denied',
      data: { tool: 'apply_patch', reason: 'Approval lacks a current, unused patch or requests broader permissions' },
    });
    return { decision: 'decline' };
  }

  private approve(message: RpcMessage): unknown {
    if (message.method === 'item/tool/call') return this.callTool(message.params);
    if (!this.editing) return undefined;
    if (message.method === 'item/fileChange/requestApproval') return this.approvePatch(this.editing, message.params);
    this.emit({ type: 'tool.denied', data: { tool: message.method, reason: 'Only scoped file patches are enabled' } });
    if (message.method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
    // Unknown permission/tool requests keep the transport's default rejection.
    return undefined;
  }

  private message(message: RpcMessage): void {
    if (!message.method || !this.active) return;
    const thread = notificationThread(message.params);
    // Thread-scoped messages for another thread, and known ones without a thread, are not ours.
    if (thread !== this.threadId && (thread !== null || isKnownCodexNotification(message.method))) return;
    const classified = classifyCodexNotification(message.method, message.params);
    if (classified.kind === 'ignored') return;
    if (classified.kind === 'unrecognized') {
      if (this.unrecognized.report(classified.method))
        this.emit(
          protocolDiagnostic('protocol.unrecognized', {
            provider: 'codex',
            messageType: classified.method,
            excerpt: classified.excerpt,
          }),
        );
      return;
    }
    if (classified.kind === 'malformed') {
      this.emit(
        protocolDiagnostic('protocol.malformed', {
          provider: 'codex',
          messageType: classified.method,
          excerpt: classified.excerpt,
          issues: classified.issues,
        }),
      );
      return;
    }
    this.notification(this.active, classified.notification);
  }

  private notification(active: ActiveTurn, notification: CodexNotification): void {
    if (notification.method === 'turn/started') {
      const id = notification.params.turn.id;
      if (active.turnId && active.turnId !== id) return;
      active.turnId = id;
      this.emit({ type: 'turn.started', data: { providerTurnId: active.turnId } });
      return;
    }
    if (notification.method === 'turn/completed') {
      this.completeTurn(active, notification.params.turn);
      return;
    }
    const turnId = notification.params.turnId;
    if (turnId && active.turnId && turnId !== active.turnId) return;
    if (this.editing && active.turnId !== null && turnId === active.turnId && !active.stopping)
      this.trackPatch(active, notification);
    switch (notification.method) {
      case 'item/agentMessage/delta':
        this.emit({ type: 'output.delta', data: { text: notification.params.delta } });
        return;
      case 'item/completed': {
        const text = agentMessageText(notification.params.item);
        if (text !== null) active.text = text;
        return;
      }
      case 'thread/tokenUsage/updated':
        this.usage(active, notification.params.tokenUsage);
        return;
      case 'error':
        this.emit({
          type: 'provider.error',
          data: {
            message: boundedExcerpt(notification.params.error.message),
            willRetry: notification.params.willRetry ?? null,
          },
        });
        return;
      case 'item/started':
      case 'item/fileChange/patchUpdated':
        return;
    }
  }

  private trackPatch(active: ActiveTurn, notification: CodexNotification): void {
    if (notification.method === 'item/started') {
      const item = fileChangeItem(notification.params.item);
      if (!item) return;
      if (active.seenItems.has(item.id)) active.patches.delete(item.id);
      else {
        if (active.seenItems.size >= providerLimits.turnPatchItems) throw new Error('Native patch item limit exceeded');
        active.seenItems.add(item.id);
        if (item.status === 'inProgress') active.patches.set(item.id, item.changes);
      }
    }
    if (notification.method === 'item/fileChange/patchUpdated' && active.patches.has(notification.params.itemId))
      active.patches.set(notification.params.itemId, notification.params.changes);
    if (notification.method === 'item/completed' && notification.params.item.type === 'fileChange') {
      const id = itemId(notification.params.item);
      if (id !== null) active.patches.delete(id);
    }
  }

  private usage(
    active: ActiveTurn,
    tokenUsage: Extract<CodexNotification, { method: 'thread/tokenUsage/updated' }>['params']['tokenUsage'],
  ): void {
    const inputTokens = numeric(tokenUsage.last?.inputTokens);
    if (inputTokens !== null)
      this.emit({
        type: 'context.updated',
        data: { inputTokens, windowTokens: numeric(tokenUsage.modelContextWindow) },
      });
    const total = tokenUsage.total;
    active.usage = {
      scope: 'provider-session-cumulative',
      inputTokens: numeric(total?.inputTokens),
      outputTokens: numeric(total?.outputTokens),
      cachedInputTokens: numeric(total?.cachedInputTokens),
      estimatedCostUsd: null,
      billedCostUsd: null,
    };
    this.emit({ type: 'usage.updated', data: active.usage });
  }

  private completeTurn(
    active: ActiveTurn,
    turn: Extract<CodexNotification, { method: 'turn/completed' }>['params']['turn'],
  ): void {
    if (active.turnId && turn.id !== active.turnId) return;
    this.active = null;
    const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
    try {
      active.resolve({
        status,
        reply: status === 'completed' ? parseReply(active.text) : null,
        usage: active.usage,
        error: turn.error?.message ?? null,
      });
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async turn(prompt: string): Promise<TurnResult> {
    if (this.active) throw new Error('Codex already has an active turn');
    let resolve!: ActiveTurn['resolve'];
    let reject!: ActiveTurn['reject'];
    const result = new Promise<TurnResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A notification or disconnect may arrive before turn/start acknowledges.
    void result.catch(() => {});
    this.active = {
      resolve,
      reject,
      turnId: null,
      text: '',
      usage: null,
      patches: new Map(),
      seenItems: new Set(),
      toolCalls: new Set(),
      stopping: false,
    };
    try {
      const started = parseCodexResponse(
        'turn/start',
        turnStartSchema,
        await this.rpc.request('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: prompt }],
          outputSchema: replyOutputSchema,
        }),
      );
      if (this.active) {
        if (this.active.turnId && this.active.turnId !== started.turn.id)
          throw new Error('Codex acknowledged a different turn');
        this.active.turnId = started.turn.id;
      }
    } catch (error) {
      this.active = null;
      throw error;
    }
    return result.then(async output => {
      await reportIntegrations(this.rpc, this.threadId, this.emit);
      return output;
    });
  }

  async interrupt(): Promise<void> {
    if (this.active) this.active.stopping = true;
    if (!this.active?.turnId) throw new Error('Codex turn has not been acknowledged; shutdown is required');
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.active.turnId });
  }

  async close(): Promise<void> {
    this.active?.reject(new Error('Codex session closed before completion'));
    this.active = null;
    this.unsubscribe.forEach(unsubscribe => unsubscribe());
    await this.rpc.close();
  }
}
