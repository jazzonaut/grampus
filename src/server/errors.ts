// Owns how dashboard API failures become HTTP responses. Errors are mapped by class, never by message:
//
// - `HttpError` carries its own status (400 invalid body, 404 unknown route or record, 413, 415).
// - `BoundaryError` from a request body is 400 with field-level issues.
// - `RecordNotFoundError` from the journal is 404.
// - `StaleStateError` is 409: the decision named a state that is no longer current.
// - `RunnerPoolFullError` is 409: `maxConcurrentTasks` guided tasks already run; nothing was queued.
// - Any other error is a refusal by the controller (an invariant or a gate) and is 400.
//
// Orchestration still throws plain `Error`s for stale keys it detects itself inside a transaction (a race
// after the server's own check); those remain 400 until orchestration throws `StaleStateError`.
import { BoundaryError } from '../process/boundary.js';
import { RecordNotFoundError, StaleStateError } from '../persistence/errors.js';
import { RunnerPoolFullError } from '../orchestration/guided/runner-pool.js';

/** An API failure with an explicit HTTP status. */
export class HttpError extends Error {
  readonly status: number;
  readonly issues: readonly string[];
  constructor(status: number, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.issues = issues;
  }
}

/** The JSON body of an error response. */
export interface ErrorBody {
  error: string;
  issues?: readonly string[];
}

/** The status and body for an error raised while handling an API request. */
export function errorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof HttpError)
    return {
      status: error.status,
      body: { error: error.message, ...(error.issues.length ? { issues: error.issues } : {}) },
    };
  if (error instanceof RecordNotFoundError) return { status: 404, body: { error: error.message } };
  if (error instanceof StaleStateError || error instanceof RunnerPoolFullError)
    return { status: 409, body: { error: error.message } };
  if (error instanceof BoundaryError && error.kind === 'http-request')
    return { status: 400, body: { error: error.message, issues: error.issues } };
  return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
}
