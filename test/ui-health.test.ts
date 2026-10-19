// Dashboard health and stall surfaces: /api/health and its refresh, the health summary in the v1
// overview (no executable paths), and stall detection of the dashboard's watchdog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startUi } from '../src/server/ui-server.js';
import { Store } from '../src/persistence/store.js';
import { guidedRecord, taskRecord } from './helpers/task-records.js';
import type { HealthReport } from '../src/health/health-record.js';
import type { Session } from '../src/persistence/records.js';
import type { OverviewV1 } from '../src/server/api-types.js';

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
  const overview = (await (await get('/api/v1/overview')).json()) as OverviewV1;
  assert.equal(overview.health.overall, 'unknown');
  assert.equal(overview.health.label, 'Integrations not checked yet');
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/health?refresh=1')).status, 409);
});

test('a configured check runs once at start when stale, on refresh, and is summarised without paths in the overview', async t => {
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
  const text = await (await get('/api/v1/overview')).text();
  const overview = JSON.parse(text) as OverviewV1;
  assert.equal(overview.health.overall, 'ready');
  assert.equal(overview.health.checkedAt, new Date(now).toISOString());
  assert.equal(overview.health.integrations[0]?.version, '0.163.0');
  assert.equal(overview.health.integrations[0]?.capabilities[0]?.statusLabel, 'Healthy');
  assert.doesNotMatch(text, /codex\.exe/, 'no executable paths');
});

test('a fresh stored result is not checked again at start, and the watchdog reports a silent session', async t => {
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
  assert.equal(calls, 0, 'a result younger than healthCheckIntervalMs is kept');
  assert.equal(ui.stalls.stall(taskId), null);
  now = last + 600_000;
  ui.stalls.scan();
  // The v1 overview and task view present this through `stallView` (test/view-model*.test.ts).
  assert.equal(ui.stalls.stall(taskId)?.owner.label, 'claude');
});
