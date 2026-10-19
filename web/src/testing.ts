// Test helpers: a fake local server for `fetch` that answers from typed DTOs and records every request,
// and mounting with the plugins the app installs. Used only by `*.test.ts`.
import { vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import icons from '@nuxt/ui/runtime/vue/plugins/icons.js';
import type { Component } from 'vue';
import { tokenStorageKey } from './api/client';

/** One request the client sent. */
export interface SentRequest {
  method: string;
  path: string;
  body: unknown;
}

/** An answer: a JSON body (200), or `status(code, body)`; or a function of the request returning one. */
type Route = (request: SentRequest) => unknown;

/** A reply with an explicit status, e.g. `status(409, { error: … })`. */
export function status(code: number, body: unknown): { status: number; body: unknown } {
  return { status: code, body };
}

function isStatus(value: unknown): value is { status: number; body: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'body' in value &&
    Object.keys(value).length === 2
  );
}

/**
 * Stubs `fetch` with `routes` keyed by `METHOD path` (query included) or by path alone for GET. Unknown
 * routes answer 404. Returns the list of requests sent, in order.
 */
export function fakeServer(routes: Record<string, unknown>): SentRequest[] {
  window.sessionStorage.setItem(tokenStorageKey, 'a'.repeat(64));
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const request: SentRequest = {
        method,
        path: input,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      sent.push(request);
      const route = routes[`${method} ${input}`] ?? (method === 'GET' ? routes[input] : undefined);
      const reply: unknown =
        route === undefined
          ? status(404, { error: { status: 404, code: 'not_found', message: 'Not found' } })
          : typeof route === 'function'
            ? (route as Route)(request)
            : route;
      const { status: code, body } = isStatus(reply) ? reply : { status: 200, body: reply };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } }),
      );
    }),
  );
  return sent;
}

/** Mounts a component with the icon plugin, attached to the document so focus works, and settles fetches. */
export async function render(component: Component, props: Record<string, unknown> = {}) {
  const wrapper = mount(component, { props, attachTo: document.body, global: { plugins: [icons] } });
  await flushPromises();
  return wrapper;
}

/** The POST requests sent, without polling reads. */
export function posts(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter(request => request.method === 'POST');
}
