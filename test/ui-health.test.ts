// Dashboard health and stall surfaces: /api/health and its refresh, the compact health in /api/state, the
// stall field on task summaries and polls, and the legacy client's header indicator and stall badge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { startUi } from '../src/server/ui-server.js';
import { Store } from '../src/persistence/store.js';
import { guidedRecord, taskRecord } from './helpers/task-records.js';
import type { HealthReport } from '../src/health/health-record.js';
import type { Session } from '../src/persistence/records.js';

const healthy = (checkedAt: string): HealthReport => ({
  checkedAt,
  durationMs: 5,
  application: '0.1.0',
  fingerprint: 'abc',
  integrations: [
    {
      id: 'codex',
      required: true,
      status: 'healthy',
      executable: 'C:\\tools\\codex.exe',
      version: '0.163.0',
      sdkVersion: null,
      fingerprint: 'codex 0.163.0',
      capabilities: [{ name: 'handshake', status: 'healthy', detail: 'ok' }],
    },
  ],
});

async function dashboard(
  t: { after(fn: () => Promise<void>): void },
  options: Omit<Parameters<typeof startUi>[0], 'db' | 'port'>,
) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-health-'));
  const db = join(root, 'grampus.sqlite');
  const ui = await startUi({ db, port: 0, ...options });
  t.after(async () => {
    await ui.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = new URL(ui.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  return { ui, get: async (path: string) => fetch(url.origin + path, { headers }) };
}

test('without a configured check the dashboard shows stored health and refuses a refresh', async t => {
  const { get } = await dashboard(t, {});
  const state = (await (await get('/api/state')).json()) as { health: { status: string } };
  assert.equal(state.health.status, 'unknown');
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/health?refresh=1')).status, 409);
});

test('a configured check runs once at start when stale, on refresh, and is shown compactly in /api/state', async t => {
  let calls = 0;
  const now = Date.parse('2026-10-19T12:00:00.000Z');
  const { ui, get } = await dashboard(t, {
    now: () => now,
    health: async () => {
      calls++;
      return healthy(new Date(now).toISOString());
    },
  });
  // The start-up check runs in the background; wait until it has stored its result.
  for (let attempt = 0; attempt < 50 && ui.store.health() === null; attempt++) await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  const refreshed = (await (await get('/api/health?refresh=1')).json()) as { status: string; stale: boolean };
  assert.deepEqual([refreshed.status, refreshed.stale, calls], ['healthy', false, 2]);
  const state = (await (await get('/api/state')).json()) as {
    health: { status: string; integrations: Record<string, unknown>[] };
  };
  assert.equal(state.health.status, 'healthy');
  assert.equal(state.health.integrations[0]?.['version'], '0.163.0');
  assert.equal('executable' in (state.health.integrations[0] ?? {}), false);
});

test('a fresh stored result is not checked again at start, and stalls appear on summaries and polls', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-stall-'));
  const db = join(root, 'grampus.sqlite');
  const taskId = randomUUID(),
    workspaceId = randomUUID(),
    sessionId = randomUUID();
  const seed = new Store(db);
  seed.transaction(() => {
    seed.saveHealth(healthy(new Date().toISOString()));
    seed.save(
      taskId,
      taskRecord(taskId, {
        brief: { title: 'Silent', outcome: 'Fixture outcome', criteria: ['Fixture criterion'], plan: 'Fixture plan' },
        guided: guidedRecord({ status: 'running', stage: 'review' }),
      }),
    );
    seed.saveWorkspace(workspaceId, taskId, workspaceId, { id: workspaceId } as never);
    const session: Session = {
      id: sessionId,
      provider: 'claude',
      runtime: { executable: null, source: 'bundled', version: null, sdkVersion: null },
      providerSessionId: null,
      model: null,
      cwd: root,
      phase: 'running',
      lastReply: null,
      run: null,
    };
    seed.saveSession(sessionId, session);
    seed.saveExecution(randomUUID(), taskId, workspaceId, sessionId, {} as never);
    seed.appendSession(sessionId, 'turn.started', {});
  });
  const last = Date.parse(seed.sessionEvents(sessionId).at(-1)!.at);
  seed.close();
  let now = last;
  let calls = 0;
  const ui = await startUi({
    db,
    port: 0,
    now: () => now,
    health: async () => {
      calls++;
      return healthy(new Date(now).toISOString());
    },
  });
  t.after(async () => {
    await ui.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = new URL(ui.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const get = async (path: string) => (await fetch(url.origin + path, { headers })).json();
  assert.equal(calls, 0, 'a result younger than healthCheckIntervalMs is kept');
  const before = (await get('/api/state')) as { tasks: { id: string; stalled: unknown }[] };
  assert.equal(before.tasks[0]?.stalled, null);
  now = last + 600_000;
  ui.stalls.scan();
  const after = (await get('/api/state')) as { tasks: { stalled: { owner: { label: string } } | null }[] };
  assert.equal(after.tasks[0]?.stalled?.owner.label, 'claude');
});

function client() {
  const app = { innerHTML: '', querySelectorAll: () => [], addEventListener: () => {} };
  const context = createContext({
    Event,
    document: {
      querySelector: (selector: string) => (selector === '#app' ? app : { addEventListener() {} }),
      getElementById: () => null,
    },
    location: { hash: '' },
    sessionStorage: { getItem: () => null, setItem() {} },
  });
  context['window'] = context;
  const source = readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
  runInContext(source.split(/\r?\nrefresh\(true\)\.catch\(showError\);/)[0]!, context);
  return context;
}

test('the header health indicator expands to statuses and warnings, and silence shows a badge', () => {
  const context = client();
  assert.equal(runInContext('healthIndicator(undefined)', context), '');
  context['health'] = {
    status: 'attention',
    checkedAt: new Date().toISOString(),
    stale: true,
    warnings: ['Codex changed from 0.162.0 to 0.163.0 since the last successful delivery.'],
    integrations: [
      {
        id: 'codex',
        status: 'auth_unavailable',
        version: '0.163.0',
        capabilities: [{ name: 'auth', status: 'auth_unavailable', detail: 'Not signed in <now>' }],
      },
    ],
  };
  const html = runInContext('healthIndicator(health)', context) as string;
  assert.match(html, /<details class="health attention"><summary>Integrations need attention<\/summary>/);
  assert.match(html, /Codex changed from 0\.162\.0 to 0\.163\.0/);
  assert.match(html, /auth: Sign-in needed · Not signed in &lt;now&gt;/);
  assert.match(html, /due for a new check/);
  assert.match(html, /data-action="health-refresh"/);
  context['stalled'] = {
    since: new Date().toISOString(),
    lastActivityAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    owner: { kind: 'session', id: 's', label: 'claude' },
  };
  assert.match(runInContext('stallBadge(stalled)', context) as string, /No activity for 12 min/);
  assert.match(
    runInContext('stallNotice(stalled)', context) as string,
    /Claude session for 12 min\. Nothing has been stopped/,
  );
  assert.equal(runInContext('stallBadge(null)', context), '');
});
