// Typed calls to the dashboard API. Errors carry the server's message so pages can show it as is.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<ApiError> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    return new ApiError(response.status, body.error ?? text);
  } catch {
    return new ApiError(response.status, text || response.statusText);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

export async function getText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw await failure(response);
  return response.text();
}

/** Send JSON. Writes are refused unless they come from this page's origin, which `fetch` guarantees. */
export async function sendJson<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}
