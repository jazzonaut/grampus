import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorV1 } from '../../../src/server/api-types';
import { ApiError, accessMessage, bootstrapToken, get, needsAccessLink, post, tokenStorageKey } from './client';

const token = 'a'.repeat(64);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', `/#${token}`);
  bootstrapToken();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('bootstrapToken', () => {
  it('opens an Orca task link after removing its access token', () => {
    window.history.replaceState(null, '', `/#${token}!/tasks/a1b2-c3d4`);
    expect(bootstrapToken()).toBe(true);
    expect(window.sessionStorage.getItem(tokenStorageKey)).toBe(token);
    expect(window.location.hash).toBe('#/tasks/a1b2-c3d4');
    expect(window.location.href).not.toContain(token);
  });

  it('refuses a navigation target outside task routes', () => {
    window.history.replaceState(null, '', `/#${token}!https://example.invalid`);
    expect(bootstrapToken()).toBe(true);
    expect(window.location.hash).toBe('');
  });
  it('moves the fragment token into session storage and strips it from the address', () => {
    window.history.replaceState(null, '', `/?view=demo#${token}`);

    expect(bootstrapToken()).toBe(true);

    expect(window.sessionStorage.getItem(tokenStorageKey)).toBe(token);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(token);
    expect(window.location.search).toBe('?view=demo');
    expect(needsAccessLink.value).toBe(false);
  });

  it('ignores an in-page fragment that is not a token', () => {
    window.sessionStorage.setItem(tokenStorageKey, token);
    window.history.replaceState(null, '', '/#main');

    expect(bootstrapToken()).toBe(false);

    expect(window.sessionStorage.getItem(tokenStorageKey)).toBe(token);
  });

  it('lets the server decide whether a token is required', () => {
    expect(bootstrapToken()).toBe(false);
    expect(needsAccessLink.value).toBe(false);
  });
});

describe('requests', () => {
  it('sends the token as a bearer header and the decision key in the body', async () => {
    window.sessionStorage.setItem(tokenStorageKey, token);
    const fetch = vi.fn<typeof window.fetch>().mockResolvedValue(jsonResponse(202, { ok: true }));
    vi.stubGlobal('fetch', fetch);

    await expect(post('/api/tasks/1/run', { expected: 'key-1' })).resolves.toEqual({ ok: true });

    const [path, init] = fetch.mock.calls[0] ?? [];
    expect(path).toBe('/api/tasks/1/run');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(typeof init?.body === 'string' ? JSON.parse(init.body) : null).toEqual({ expected: 'key-1' });
  });

  it('turns a 401 into the access-link state', async () => {
    window.sessionStorage.setItem(tokenStorageKey, token);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Open the link' })));

    const error: unknown = await get('/api/v1/overview').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).unauthorised).toBe(true);
    expect((error as ApiError).message).toBe(accessMessage);
    expect(needsAccessLink.value).toBe(true);

    // A fresh link clears the state.
    window.history.replaceState(null, '', `/#${'b'.repeat(64)}`);
    bootstrapToken();
    expect(needsAccessLink.value).toBe(false);
  });

  it('calls the server without an authorisation header when there is no token', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);

    await expect(get('/api/v1/overview')).resolves.toEqual({ ok: true });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
  });

  it('surfaces the server error message with its status', async () => {
    window.sessionStorage.setItem(tokenStorageKey, token);
    const body: ErrorV1 = {
      error: { status: 409, code: 'stale_state', message: 'Task changed since you inspected it' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, body)));

    const error: unknown = await post('/api/tasks/1/approve', { expected: 'stale' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: 'stale_state', message: 'Task changed since you inspected it' });
    expect((error as ApiError).stale).toBe(true);
    expect((error as ApiError).poolFull).toBe(false);
  });

  it('tells a full runner pool apart from a stale page', () => {
    const full = new ApiError(409, '2 of 2 guided tasks are already running', 'pool_full');
    expect(full.poolFull).toBe(true);
    expect(full.stale).toBe(false);
  });

  it('reads the message of the typed v1 error envelope', async () => {
    window.sessionStorage.setItem(tokenStorageKey, token);
    const body: ErrorV1 = { error: { status: 404, code: 'not_found', message: 'This task was deleted' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, body)));

    await expect(get('/api/v1/tasks/1')).rejects.toMatchObject({ status: 404, message: 'This task was deleted' });
  });
});
