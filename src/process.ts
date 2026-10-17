import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';

export function command(file: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file}: ${error.killed ? 'timed out' : `failed (${error.code ?? error.signal ?? 'unknown'})`}`));
      else resolve(stdout.trim() || stderr.trim());
    });
    // Discovery commands receive no input; CLIs that read piped stdin need EOF.
    child.stdin?.end();
  });
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

/** Bounded requests plus notifications for one owned app-server process. */
export class RpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private stopped = false;
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private serverRequest: ((message: RpcMessage) => unknown) | null = null;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly exited: Promise<void>;

  constructor(file: string, args: string[], options: Pick<SpawnOptionsWithoutStdio, 'cwd' | 'env'> = {}) {
    this.child = spawn(file, args, { ...options, windowsHide: true, stdio: 'pipe', shell: false });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', () => this.fail(new Error('RPC process exited')));
    this.child.stdin.on('error', error => this.fail(error));
    // Drain stderr, but do not expose provider configuration or private log output.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > 1024 * 1024) { this.fail(new Error('RPC message too large')); return; }
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { this.fail(new Error('Invalid JSON from RPC process')); return; }
      if (!message || typeof message !== 'object') { this.fail(new Error('Invalid RPC message')); return; }
      try { for (const listener of this.listeners) listener(message); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      if (message.method && message.id !== undefined) {
        // Synchronous handlers must persist authorization before returning it.
        // Undefined, exceptions and a stopped transport never authorize work.
        let result: unknown;
        try { if (!this.stopped) result = this.serverRequest?.(message); } catch { result = undefined; }
        this.child.stdin.write(`${JSON.stringify(result === undefined
          ? { id: message.id, error: { code: -32601, message: 'Client does not accept this server request' } }
          : { id: message.id, result })}\n`);
        return;
      }
      if (typeof message.id !== 'number') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  onRequest(handler: (message: RpcMessage) => unknown): () => void {
    if (this.serverRequest) throw new Error('RPC server request handler already registered');
    this.serverRequest = handler;
    return () => { if (this.serverRequest === handler) this.serverRequest = null; };
  }

  get pid(): number | undefined { return this.child.pid; }

  request<T>(method: string, params: unknown, timeout = 15_000): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('RPC process unavailable'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    if (this.stopped) throw new Error('RPC process unavailable');
    this.child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`);
  }

  async close(): Promise<void> {
    this.fail(new Error('RPC client closed'));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1000);
    const force = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('RPC shutdown unconfirmed')), 4000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(force);
      clearTimeout(deadline);
    }
  }
}
