// HTTP access to the local Grampus server: the per-launch access token and typed JSON requests.
//
// The server prints a link carrying a random token in the URL fragment (never sent to the
// server in a request line or Referer). The client moves it into session storage, removes it
// from the address bar and sends it as a bearer token on every API call.
import { readonly, ref } from 'vue';
import type { ErrorCodeV1 } from '../../../src/server/api-types';

/** Session storage key of the access token. */
export const tokenStorageKey = 'grampus-token';

/**
 * What a token in the fragment looks like. Grampus issues 64 hex characters; anything short or
 * unusual (such as `#main` from an in-page link) is not a token and is left alone.
 */
const tokenPattern = /^[A-Za-z0-9._~-]{32,}$/;

/** Shown whenever the server refuses the token, or there is none. */
export const accessMessage = 'Open the complete local dashboard link printed by Grampus.';

/** Why a request failed. `status` is 0 when the server could not be reached at all. */
export class ApiError extends Error {
  public readonly status: number;
  /** The server's error code (`ErrorV1`), or null when it sent none. */
  public readonly code: ErrorCodeV1 | null;
  /** Field-level problems of an invalid request. */
  public readonly issues: readonly string[];

  public constructor(status: number, message: string, code: ErrorCodeV1 | null = null, issues: readonly string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /** The token is missing or was refused: only a fresh link from Grampus helps. */
  public get unauthorised(): boolean {
    return this.status === 401;
  }

  /**
   * The server refused because what the page showed is no longer current (a changed decision key, turn
   * key or proposal digest, or an action already running): refetch and let the person decide again.
   */
  public get stale(): boolean {
    return this.status === 409;
  }
}

const accessRequired = ref(false);

/** True after a 401 or when no token is held. Cleared when a new link supplies a token. */
export const needsAccessLink = readonly(accessRequired);

/**
 * Moves a token from the URL fragment into session storage and strips the fragment.
 *
 * Call once before the first request, and again on `hashchange` so pasting a fresh link into a
 * tab that is already open works. Returns whether a new token was taken from the fragment.
 */
export function bootstrapToken(): boolean {
  const fragment = window.location.hash.slice(1);
  if (!tokenPattern.test(fragment)) {
    // Keep an earlier refusal: an unrelated fragment does not make a refused token valid.
    if (readToken() === '') accessRequired.value = true;
    return false;
  }
  window.sessionStorage.setItem(tokenStorageKey, fragment);
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  accessRequired.value = false;
  return true;
}

function readToken(): string {
  return window.sessionStorage.getItem(tokenStorageKey) ?? '';
}

/**
 * Body of a request that changes controller state. `expected` is the decision key the page
 * displayed; the server rejects the action if the task has changed since, so a stale tab can
 * never approve or authorise something the user did not see.
 */
export interface DecisionBody {
  readonly expected: string;
  readonly [field: string]: unknown;
}

/** Body of a request that acts on no displayed state: creating a planning session, lookups. */
export type UnkeyedBody = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The error a failed response carries: the typed envelope (ErrorV1 in src/server/api-types.ts) every route uses. */
async function responseError(response: Response): Promise<ApiError> {
  const fallback = response.statusText || `Request failed (${response.status})`;
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) ? body['error'] : undefined;
    if (isRecord(error) && typeof error['message'] === 'string') {
      const issues = Array.isArray(error['issues'])
        ? error['issues'].filter((item): item is string => typeof item === 'string')
        : [];
      const code = typeof error['code'] === 'string' ? (error['code'] as ErrorCodeV1) : null;
      return new ApiError(response.status, error['message'], code, issues);
    }
  } catch {
    // Not JSON: fall through to the status text.
  }
  return new ApiError(response.status, fallback);
}

/** One request to the local server with the access token; the shared path of every call. */
export async function request<T>(method: 'GET' | 'POST', path: string, body?: UnkeyedBody | null): Promise<T> {
  const token = readToken();
  if (token === '') {
    accessRequired.value = true;
    throw new ApiError(401, accessMessage);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      cache: 'no-store',
      ...(body === undefined || body === null ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the local Grampus server. Check that its terminal is still open.');
  }
  if (response.status === 401) {
    accessRequired.value = true;
    throw new ApiError(401, accessMessage);
  }
  if (!response.ok) throw await responseError(response);
  // The server's JSON is trusted to match T: both sides are compiled against src/server/api-types.ts.
  return (await response.json()) as T;
}

/** GET a JSON resource from the local server, e.g. `get<OverviewV1>('/api/v1/overview')`. */
export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

/** POST a decision: the body must carry the decision key the page displayed. */
export function post<T>(path: string, body: DecisionBody): Promise<T> {
  return request<T>('POST', path, body);
}

/** POST that acts on no displayed state, such as creating a planning session or a file search. */
export function postUnkeyed<T>(path: string, body: UnkeyedBody): Promise<T> {
  return request<T>('POST', path, body);
}
