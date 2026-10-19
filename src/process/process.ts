import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { processLimits } from '../config/limits.js';
import { BoundaryError, describeIssues } from './boundary.js';

export function command(
  file: string,
  args: string[],
  timeout: number = processLimits.commandTimeoutMs,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout, maxBuffer: processLimits.commandOutputBytes, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`${file}: ${error.killed ? 'timed out' : `failed (${error.code ?? error.signal ?? 'unknown'})`}`),
          );
        else resolve(stdout.trim() || stderr.trim());
      },
    );
    // Discovery commands receive no input; CLIs that read piped stdin need EOF.
    child.stdin?.end();
  });
}

/**
 * The JSON-RPC 2.0 envelope (without the `jsonrpc` member, which app-server omits). This pins only the
 * envelope: method results and notification parameters stay `unknown` here and are parsed by the
 * protocol module of whoever owns the method. A line that is not an envelope fails the transport.
 */
export const rpcMessageSchema = z.object({
  id: z.union([z.number(), z.string()]).nullable().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional(),
});
export type RpcMessage = z.infer<typeof rpcMessageSchema>;

/** Bounded requests plus notifications for one owned app-server process. */
export class RpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private stopped = false;
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private serverRequest: ((message: RpcMessage) => unknown) | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
      if (Buffer.byteLength(line) > processLimits.rpcLineBytes) {
        this.fail(new Error('RPC message too large'));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.fail(new Error('Invalid JSON from RPC process'));
        return;
      }
      const parsed = rpcMessageSchema.safeParse(value);
      if (!parsed.success) {
        const issues = describeIssues(parsed.error);
        this.fail(
          new BoundaryError(
            { kind: 'provider-protocol', source: 'JSON-RPC envelope' },
            issues,
            `Invalid RPC message: ${issues.join('; ')}`,
          ),
        );
        return;
      }
      const message = parsed.data;
      try {
        for (const listener of this.listeners) listener(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.method && message.id !== undefined) {
        // Synchronous handlers must persist authorization before returning it.
        // Undefined, exceptions and a stopped transport never authorize work.
        let result: unknown;
        try {
          if (!this.stopped) result = this.serverRequest?.(message);
        } catch {
          result = undefined;
        }
        this.child.stdin.write(
          `${JSON.stringify(
            result === undefined
              ? { id: message.id, error: { code: -32601, message: 'Client does not accept this server request' } }
              : { id: message.id, result },
          )}\n`,
        );
        return;
      }
      if (typeof message.id !== 'number') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message ?? 'RPC request failed'));
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
    return () => {
      if (this.serverRequest === handler) this.serverRequest = null;
    };
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolves with the raw, unvalidated result; the caller parses it with the method's own schema. */
  request(method: string, params: unknown, timeout: number = processLimits.rpcRequestTimeoutMs): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('RPC process unavailable'));
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
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
    const timer = setTimeout(() => this.child.kill(), processLimits.rpcTerminateMs);
    const force = setTimeout(() => this.child.kill('SIGKILL'), processLimits.rpcKillMs);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('RPC shutdown unconfirmed')), processLimits.rpcShutdownMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(force);
      clearTimeout(deadline);
    }
  }
}
