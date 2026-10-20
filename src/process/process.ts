// Owns shell-free subprocesses: short bounded helper commands and the line-delimited JSON-RPC transport
// for one owned app-server process. It pins only the RPC envelope; it must not interpret method results,
// and it never authorises a server request on its own.
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

/**
 * Run a short helper command; `cwd` defaults to this process's working directory.
 *
 * No shell is involved, output is capped at `processLimits.commandOutputBytes` and stdin is closed at once.
 * Resolves with trimmed stdout, or trimmed stderr when stdout is empty.
 * Rejects on a timeout, a non-zero exit or a spawn failure; the error names only the file and the exit
 * code or signal, never the command's output.
 */
export function command(
  file: string,
  args: string[],
  timeout: number = processLimits.commandTimeoutMs,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout, maxBuffer: processLimits.commandOutputBytes, windowsHide: true, encoding: 'utf8', cwd },
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

/**
 * Bounded requests plus notifications for one owned app-server process.
 *
 * The transport fails once and for good: a spawn error, process exit, an oversized or non-JSON line, an
 * invalid envelope or a throwing message listener rejects every pending request with that error, notifies
 * the failure listeners and refuses later requests. Server requests are answered only with a value the
 * registered handler returns, including an awaited diagnostic result. Undefined and failed handlers
 * get a JSON-RPC error; a stopped transport never returns an authorisation.
 */
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
        // Authorisation precedes dispatch; asynchronous tools return their settled diagnostics.
        // Undefined, exceptions and a stopped transport never authorise work.
        let result: unknown;
        try {
          if (!this.stopped) result = this.serverRequest?.(message);
        } catch {
          result = undefined;
        }
        // Native permission decisions must still be sent synchronously. Only diagnostic tools
        // may wait for process settlement, while the transport continues receiving stop events.
        if (result instanceof Promise)
          void result.then(
            value => this.respond(message.id, value),
            () => this.respond(message.id, undefined),
          );
        else this.respond(message.id, result);
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

  /** Sends a settled server-request result only while this transport still owns its child. */
  private respond(id: RpcMessage['id'], result: unknown): void {
    if (this.stopped) return;
    this.child.stdin.write(
      `${JSON.stringify(
        result === undefined
          ? { id, error: { code: -32601, message: 'Client does not accept this server request' } }
          : { id, result },
      )}\n`,
    );
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

  /**
   * Observe every valid envelope, before requests are answered or responses settled. A listener that
   * throws fails the whole transport. Returns an unsubscribe function.
   */
  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observe the single terminal failure of the transport (including `close`). Returns an unsubscribe function. */
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  /**
   * Register the one handler that answers server-initiated requests. The handler must persist any
   * authorisation before dispatching work; undefined, rejection or a throw is answered as refused.
   *
   * @throws Error when a handler is already registered, so two owners cannot both answer approvals.
   */
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

  /**
   * Resolves with the raw, unvalidated result; the caller parses it with the method's own schema.
   * Rejects when the transport has stopped, on the response's JSON-RPC error, when the transport fails
   * while the request is pending, or after `timeout` ms. A timeout or transport failure says nothing about
   * whether the server acted on the request.
   */
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

  /**
   * Send a parameterless notification.
   *
   * @throws Error when the transport has already stopped.
   */
  notify(method: string): void {
    if (this.stopped) throw new Error('RPC process unavailable');
    this.child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`);
  }

  /**
   * Fail the transport, end stdin, then escalate to a terminate signal and a kill on fixed timers.
   * Resolves only once the child has closed; rejects with `RPC shutdown unconfirmed` when that is not seen
   * within `processLimits.rpcShutdownMs`, because an unconfirmed exit must not be reported as settled.
   */
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
