// Dashboard API contract: request bodies are validated per route with field-level 400s in the typed error
// envelope, unknown routes and records are 404, the retired legacy reads are gone, and transport problems
// have their own statuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startUi } from '../src/server/ui-server.js';
import type { ErrorV1 } from '../src/server/api-types.js';

async function dashboard(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-api-'));
  const ui = await startUi({ db: join(root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = new URL(ui.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  return {
    get: (path: string) => fetch(url.origin + path, { headers }),
    post: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(url.origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) }),
  };
}

test('invalid request bodies are 400 with field-level issues before any controller work', async t => {
  const api = await dashboard(t);
  const missing = await api.post('/api/tasks', {});
  assert.equal(missing.status, 400);
  const body = (await missing.json()) as ErrorV1;
  assert.equal(body.error.code, 'invalid_request');
  assert.ok(
    body.error.issues?.some(issue => issue.startsWith('plan')),
    body.error.message,
  );
  const wrongType = (await (
    await api.post('/api/kickoffs', { repo: 7, request: 'x', provider: 'gpt' })
  ).json()) as ErrorV1;
  assert.ok(wrongType.error.issues?.some(issue => issue.startsWith('repo')));
  assert.ok(wrongType.error.issues?.some(issue => issue.startsWith('provider')));
  const query = await api.get(`/api/tasks/${randomUUID()}/check-output?stream=sideways`);
  assert.equal(query.status, 404, 'an unknown task is not found before its query is read');
});

test('unknown routes and records are 404 and transport problems keep their own statuses', async t => {
  const api = await dashboard(t);
  assert.equal((await api.get(`/api/tasks/${randomUUID()}`)).status, 404);
  assert.equal((await api.get('/api/nothing')).status, 404);
  // The legacy client's polls were retired with it; the Vue client reads /api/v1/.
  assert.equal((await api.get('/api/state')).status, 404);
  assert.equal((await api.post(`/api/kickoffs/${randomUUID()}/plan`, { expected: 'x' })).status, 404);
  assert.equal((await api.post(`/api/tasks/${randomUUID()}/unknown`, { expected: 'x' })).status, 404);
  assert.equal((await api.post('/api/unknown', {})).status, 404);
  assert.equal((await api.post('/api/tasks', { plan: {} }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await api.post('/api/tasks', ['not', 'an', 'object'])).status, 400);
});
