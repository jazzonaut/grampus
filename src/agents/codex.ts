import { RpcProcess, type RpcMessage } from '../process.js';
import { instructions, replySchema, parseReply, subscriptionEnvironment, numeric, type AgentSession, type ConnectOptions, type TurnResult, type Usage } from './types.js';

export async function connectCodex(options: ConnectOptions): Promise<AgentSession> {
  options.signal.throwIfAborted();
  const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'goals', 'code_mode'];
  const rpc = new RpcProcess(process.env.GRAMPUS_CODEX_COMMAND ?? 'codex', [
    'app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"',
    ...disabled.flatMap(feature => ['--disable', feature]),
  ], { cwd: options.cwd, env: subscriptionEnvironment() });
  const abort = () => { void rpc.close().catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.emit({ type: 'process.started', data: { pid: rpc.pid } });
    await rpc.request('initialize', { clientInfo: { name: 'grampus', title: 'Grampus', version: '0.1.0' } });
    rpc.notify('initialized');
    const auth = await rpc.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
    if (auth.account?.type !== 'chatgpt') throw new Error('Codex requires an existing ChatGPT subscription login');
    const config = await rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', { includeLayers: false });
    const overrides: Record<string, unknown> = { web_search: 'disabled' };
    for (const name of Object.keys(config.config.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
    const params = {
      cwd: options.cwd, modelProvider: 'openai', approvalPolicy: 'untrusted', sandbox: 'read-only',
      developerInstructions: instructions, config: overrides,
      ...(options.model ? { model: options.model } : {}),
    };
    const thread = await rpc.request<{ thread: { id: string }; model: string }>(
      options.providerSessionId ? 'thread/resume' : 'thread/start',
      options.providerSessionId ? { ...params, threadId: options.providerSessionId } : params,
    );
    if (options.providerSessionId && thread.thread.id !== options.providerSessionId) throw new Error('Codex resumed a different session');
    options.emit({ type: 'session.connected', data: { providerSessionId: thread.thread.id, model: thread.model, auth: 'subscription' } });
    options.signal.throwIfAborted();
    return new CodexSession(rpc, thread.thread.id, options.emit);
  } catch (error) { await rpc.close(); options.emit({ type: 'process.exit_confirmed', data: {} }); throw error; }
  finally { options.signal.removeEventListener('abort', abort); }
}

export class CodexSession implements AgentSession {
  private active: { resolve: (result: TurnResult) => void; reject: (error: Error) => void; turnId: string | null; text: string; usage: Usage | null } | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly rpc: RpcProcess, private readonly threadId: string, private readonly emit: ConnectOptions['emit']) {
    this.unsubscribe = [rpc.onMessage(message => this.message(message)), rpc.onFailure(error => {
      this.active?.reject(error); this.active = null;
    })];
  }

  private message(message: RpcMessage): void {
    if (!message.method || !this.active) return;
    const p = message.params as Record<string, any> | undefined;
    if (!p || p.threadId !== this.threadId) return;
    const active = this.active;
    if (message.method === 'turn/started') {
      active.turnId = p.turn.id;
      this.emit({ type: 'turn.started', data: { providerTurnId: active.turnId } });
    }
    if (p.turnId && active.turnId && p.turnId !== active.turnId) return;
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
    this.active = { resolve, reject, turnId: null, text: '', usage: null };
    try {
      const started = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId, input: [{ type: 'text', text: prompt }], outputSchema: replySchema,
      });
      if (this.active) this.active.turnId = started.turn.id;
    } catch (error) { this.active = null; throw error; }
    return result;
  }

  async interrupt(): Promise<void> {
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
