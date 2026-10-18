import { RpcProcess, type RpcMessage } from '../process.js';
import { applicationVersion } from '../runtime.js';
import { mcpInstructions } from '../integrations.js';
import { referenceInstructions } from '../reference-folders.js';
import { repositoryTools, repositoryToolDefinitions, explorationInstructions, type RepositoryAccess } from '../repository-tools.js';
import { authorizeFileChanges, implementationInstructions, type EditingContext } from '../edit-policy.js';
import { instructions, replySchema, parseReply, subscriptionEnvironment, numeric, type AgentSession, type ConnectOptions, type TurnResult, type Usage } from './types.js';

async function reportIntegrations(rpc: RpcProcess, threadId: string, emit: ConnectOptions['emit']) {
  try {
    const servers: { name: string; status: string; tools: number; auth: string }[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { name: string; runtimeStatus?: string | null; tools: Record<string, unknown>; authStatus: string }[]; nextCursor: string | null } = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100, cursor });
      servers.push(...page.data.map(item => ({ name: item.name, status: item.runtimeStatus ?? 'configured', tools: Object.keys(item.tools ?? {}).length, auth: item.authStatus })));
      cursor = page.nextCursor;
    } while (cursor && servers.length < 1000);
    emit({ type: 'integrations.updated', data: { servers } });
  } catch { emit({ type: 'integrations.updated', data: { servers: [{ name: 'Configured MCP servers', status: 'Status unavailable; provider tools remain enabled' }] } }); }
}

export async function connectCodex(options: ConnectOptions): Promise<AgentSession> {
  options.signal.throwIfAborted();
  const disabled = ['shell_tool', 'unified_exec', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'goals', 'code_mode'];
  const rpc = new RpcProcess(process.env.GRAMPUS_CODEX_COMMAND ?? 'codex', [
    'app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"',
    ...disabled.flatMap(feature => ['--disable', feature]),
  ], { cwd: options.cwd, env: subscriptionEnvironment() });
  const abort = () => { void rpc.close().catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.emit({ type: 'process.started', data: { pid: rpc.pid } });
    await rpc.request('initialize', { clientInfo: { name: 'grampus', title: 'Grampus', version: applicationVersion }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const auth = await rpc.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
    if (auth.account?.type !== 'chatgpt') throw new Error('Codex requires an existing ChatGPT subscription login');
    const overrides: Record<string, unknown> = { web_search: 'disabled' };
    const effective = await rpc.request<{ config: { mcp_servers?: Record<string, Record<string, unknown>> } }>('config/read', { includeLayers: false, cwd: options.configurationCwd ?? options.cwd });
    for (const [name, server] of Object.entries(effective.config.mcp_servers ?? {})) {
      // config/read materializes optional fields as null; TOML overrides cannot represent null.
      const configured = JSON.parse(JSON.stringify(server, (_key, value) => value === null ? undefined : value));
      overrides[`mcp_servers.${name}`] = { ...configured, enabled: server.enabled !== false };
    }
    const params = {
      cwd: options.cwd, modelProvider: 'openai', approvalPolicy: 'untrusted', sandbox: 'read-only',
      developerInstructions: options.editing ? implementationInstructions('Use only apply_patch to update approved existing files, add explicitly authorized new files or delete explicitly authorized unchanged files, using their supplied contents (null means absent). Parent directories must already exist. Deletion paths cannot be updated or recreated. Do not move files or delete directories. Each patch requires controller approval.') : instructions, config: overrides,
      ...(options.editing ? { approvalsReviewer: 'user' } : {}),
      ...(options.repository && !options.providerSessionId ? { dynamicTools: repositoryToolDefinitions.map(tool => ({ type: 'function', ...tool })) } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    params.developerInstructions += `\n${mcpInstructions}`;
    if (options.repository) params.developerInstructions += `\n${explorationInstructions}\n${referenceInstructions(options.repository.references ?? [])}`;
    const thread = await rpc.request<{ thread: { id: string }; model: string; approvalPolicy?: unknown; approvalsReviewer?: unknown; sandbox?: { type?: string; networkAccess?: boolean } }>(
      options.providerSessionId ? 'thread/resume' : 'thread/start',
      options.providerSessionId ? { ...params, threadId: options.providerSessionId } : params,
    );
    if (options.providerSessionId && thread.thread.id !== options.providerSessionId) throw new Error('Codex resumed a different session');
    if (options.editing && (thread.approvalPolicy !== 'untrusted' || thread.approvalsReviewer !== 'user'
      || thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess === true)) throw new Error('Codex did not confirm controller approvals and read-only sandbox');
    options.emit({ type: 'session.connected', data: { providerSessionId: thread.thread.id, model: thread.model, auth: 'subscription' } });
    await reportIntegrations(rpc, thread.thread.id, options.emit);
    options.signal.throwIfAborted();
    return new CodexSession(rpc, thread.thread.id, options.emit, options.editing, options.repository);
  } catch (error) { await rpc.close(); options.emit({ type: 'process.exit_confirmed', data: {} }); throw error; }
  finally { options.signal.removeEventListener('abort', abort); }
}

export class CodexSession implements AgentSession {
  private active: { resolve: (result: TurnResult) => void; reject: (error: Error) => void; turnId: string | null; text: string; usage: Usage | null;
    patches: Map<string, unknown>; seenItems: Set<string>; toolCalls: Set<string>; stopping: boolean } | null = null;
  private readonly unsubscribe: (() => void)[];
  private readonly readRepository: ReturnType<typeof repositoryTools> | undefined;

  constructor(private readonly rpc: RpcProcess, private readonly threadId: string, private readonly emit: ConnectOptions['emit'], private readonly editing?: EditingContext, repository?: RepositoryAccess) {
    this.readRepository = repository ? repositoryTools(repository, emit, () => !!this.active && !this.active.stopping) : undefined;
    this.unsubscribe = [rpc.onMessage(message => this.message(message)), rpc.onFailure(error => {
      this.active?.reject(error); this.active = null;
    }), rpc.onRequest(message => this.approve(message))];
  }

  private approve(message: RpcMessage): unknown {
    const p = message.params as Record<string, unknown> | undefined;
    const active = this.active;
    if (message.method === 'item/tool/call') {
      try {
        if (!this.readRepository || !active || active.stopping || active.turnId === null || p?.threadId !== this.threadId || p.turnId !== active.turnId || typeof p.callId !== 'string' || p.namespace != null) throw new Error('Repository tool call lacks current turn ownership');
        const callKey = `tool:${p.callId}`;
        if (active.toolCalls.has(callKey) || active.toolCalls.size >= 512) throw new Error('Duplicate repository tool call or turn tool limit exceeded');
        active.toolCalls.add(callKey);
        const result = this.readRepository(String(p.tool), p.arguments);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      } catch (error) {
        return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] };
      }
    }
    if (!this.editing) return undefined;
    if (message.method === 'item/fileChange/requestApproval') {
      const matches = active && !active.stopping && active.turnId !== null && p?.threadId === this.threadId && p.turnId === active.turnId && typeof p.itemId === 'string';
      const changes = matches ? active.patches.get(p.itemId as string) : undefined;
      if (matches) active.patches.delete(p.itemId as string); // One decision per item, including denials.
      if (changes && p && p.grantRoot == null && Object.keys(p).every(field => ['threadId', 'turnId', 'itemId', 'reason', 'grantRoot', 'startedAtMs'].includes(field))) {
        return { decision: authorizeFileChanges(this.editing, changes, this.emit) ? 'accept' : 'decline' };
      }
      this.emit({ type: 'tool.denied', data: { tool: 'apply_patch', reason: 'Approval lacks a current, unused patch or requests broader permissions' } });
      return { decision: 'decline' };
    }
    this.emit({ type: 'tool.denied', data: { tool: message.method, reason: 'Only scoped file patches are enabled' } });
    if (message.method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
    // Unknown permission/tool requests keep the transport's default rejection.
    return undefined;
  }

  private message(message: RpcMessage): void {
    if (!message.method || !this.active) return;
    const p = message.params as Record<string, any> | undefined;
    if (!p || p.threadId !== this.threadId) return;
    const active = this.active;
    if (message.method === 'turn/started') {
      if (typeof p.turn?.id !== 'string' || active.turnId && active.turnId !== p.turn.id) return;
      active.turnId = p.turn.id;
      this.emit({ type: 'turn.started', data: { providerTurnId: active.turnId } });
    }
    if (p.turnId && active.turnId && p.turnId !== active.turnId) return;
    if (this.editing && active.turnId !== null && p.turnId === active.turnId && !active.stopping) {
      if (message.method === 'item/started' && p.item?.type === 'fileChange' && typeof p.item.id === 'string') {
        if (active.seenItems.has(p.item.id)) active.patches.delete(p.item.id);
        else {
          if (active.seenItems.size >= 64) throw new Error('Native patch item limit exceeded');
          active.seenItems.add(p.item.id);
          if (p.item.status === 'inProgress') active.patches.set(p.item.id, p.item.changes);
        }
      }
      if (message.method === 'item/fileChange/patchUpdated' && active.patches.has(p.itemId)) active.patches.set(p.itemId, p.changes);
      if (message.method === 'item/completed' && p.item?.type === 'fileChange') active.patches.delete(p.item.id);
    }
    if (message.method === 'item/agentMessage/delta') {
      this.emit({ type: 'output.delta', data: { text: String(p.delta) } });
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') active.text = String(p.item.text);
    if (message.method === 'thread/tokenUsage/updated') {
      const total = p.tokenUsage?.total;
      active.usage = { scope: 'provider-session-cumulative', inputTokens: numeric(total?.inputTokens), outputTokens: numeric(total?.outputTokens),
        cachedInputTokens: numeric(total?.cachedInputTokens), estimatedCostUsd: null, billedCostUsd: null };
      this.emit({ type: 'usage.updated', data: active.usage });
    }
    if (message.method === 'turn/completed') {
      if (active.turnId && p.turn.id !== active.turnId) return;
      this.active = null;
      const status = p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed';
      try { active.resolve({ status, reply: status === 'completed' ? parseReply(active.text) : null, usage: active.usage, error: p.turn.error?.message ?? null }); }
      catch (error) { active.reject(error instanceof Error ? error : new Error(String(error))); }
    }
  }

  async turn(prompt: string): Promise<TurnResult> {
    if (this.active) throw new Error('Codex already has an active turn');
    let resolve!: (value: TurnResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<TurnResult>((yes, no) => { resolve = yes; reject = no; });
    // A notification or disconnect may arrive before turn/start acknowledges.
    void result.catch(() => {});
    this.active = { resolve, reject, turnId: null, text: '', usage: null, patches: new Map(), seenItems: new Set(), toolCalls: new Set(), stopping: false };
    try {
      const started = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId, input: [{ type: 'text', text: prompt }], outputSchema: replySchema,
      });
      if (this.active) {
        if (this.active.turnId && this.active.turnId !== started.turn.id) throw new Error('Codex acknowledged a different turn');
        this.active.turnId = started.turn.id;
      }
    } catch (error) { this.active = null; throw error; }
    return result.then(async output => { await reportIntegrations(this.rpc, this.threadId, this.emit); return output; });
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
