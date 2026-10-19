// Owns how dashboard API failures become HTTP responses. Errors are mapped by class, never by message:
//
// - `HttpError` carries its own status (400 invalid body, 401, 403, 404 unknown route or record, 409, 413, 415).
// - `BoundaryError` from a request body is 400 with field-level issues.
// - `RecordNotFoundError` from the journal is 404.
// - `StaleStateError` is 409: the decision named a state that is no longer current.
// - `RunnerPoolFullError` is 409: `maxConcurrentTasks` guided tasks already run; nothing was queued.
// - Any other error is a refusal by the controller (an invariant or a gate) and is 400.
//
// Orchestration still throws plain `Error`s for stale keys it detects itself inside a transaction (a race
// after the server's own check); those remain 400 until orchestration throws `StaleStateError`.
//
// Every route answers a failure with the typed envelope `ErrorV1` (`{ error: { status, code, message,
// issues? } }`), under `/api/v1/` and on the lookup and action routes alike.
import { BoundaryError } from '../process/boundary.js';
import { RecordNotFoundError, StaleStateError } from '../persistence/errors.js';
import { RunnerPoolFullError } from '../orchestration/guided/runner-pool.js';
import type { ErrorCodeV1, ErrorV1 } from './api-types.js';

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

/** The status, message and field-level issues of an error, by its class. */
function classify(error: unknown): { status: number; message: string; issues: readonly string[] } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpError) return { status: error.status, message, issues: error.issues };
  if (error instanceof RecordNotFoundError) return { status: 404, message, issues: [] };
  if (error instanceof StaleStateError || error instanceof RunnerPoolFullError)
    return { status: 409, message, issues: [] };
  if (error instanceof BoundaryError && error.kind === 'http-request')
    return { status: 400, message, issues: error.issues };
  return { status: 400, message, issues: [] };
}

const statusCodes: Readonly<Partial<Record<number, ErrorCodeV1>>> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden_origin',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  503: 'unavailable',
};

/** The v1 error code of an error, by class first and then by status. */
function errorCode(error: unknown, status: number): ErrorCodeV1 {
  if (error instanceof StaleStateError) return 'stale_state';
  if (error instanceof RunnerPoolFullError) return 'pool_full';
  if (error instanceof RecordNotFoundError) return 'not_found';
  if (error instanceof BoundaryError && error.kind === 'http-request') return 'invalid_request';
  if (error instanceof HttpError) return statusCodes[error.status] ?? 'refused';
  return status === 400 ? 'refused' : (statusCodes[status] ?? 'refused');
}

/** The status and typed body for an error raised while handling an API request. */
export function errorResponse(error: unknown): { status: number; body: ErrorV1 } {
  const { status, message, issues } = classify(error);
  return {
    status,
    body: {
      error: {
        status,
        code: errorCode(error, status),
        message,
        ...(issues.length ? { issues: [...issues] } : {}),
      },
    },
  };
}
