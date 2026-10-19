// Integration health: executable resolution shared with the adapters, the provider runtime recorded on
// sessions, the stored and validated health record, staleness, and the provider version change warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { BoundaryError } from '../src/process/boundary.js';
import {
  claudeExecutable,
  claudeSdk,
  codexExecutable,
  normaliseVersion,
  providerRuntime,
} from '../src/providers/executables.js';
import {
  HealthMonitor,
  compactHealth,
  healthView,
  integrationStatus,
  refreshHealth,
  refreshHealthIfStale,
  sanitiseDetail,
  versionWarnings,
} from '../src/health/health.js';
import type { HealthReport, IntegrationHealth } from '../src/health/health-record.js';
import type { Session } from '../src/persistence/records.js';
import { currentSettings } from '../src/config/settings.js';

function directory(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'grampus-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A fresh journal, closed before its directory is removed. */
function journal(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'grampus-health-'));
  const store = new Store(join(root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

/** Set environment variables for one test and restore them afterwards. */
function environment(t: { after: (fn: () => void) => void }, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  apply(values);
  t.after(() => apply(previous));
}

const integration = (overrides: Partial<IntegrationHealth> & Pick<IntegrationHealth, 'id'>): IntegrationHealth => ({
  required: true,
  status: 'healthy',
  executable: `C:\\tools\\${overrides.id}.exe`,
  version: '1.0.0',
  sdkVersion: null,
  fingerprint: `${overrides.id} 1.0.0`,
  capabilities: [{ name: 'executable', status: 'healthy', detail: 'found' }],
  ...overrides,
});
const report = (checkedAt: string, integrations: IntegrationHealth[]): HealthReport => ({
  checkedAt,
  durationMs: 12,
  application: '0.1.0',
  fingerprint: 'fixture',
  integrations,
});

test('provider executables come from the override or the pinned SDK, and sessions record what would run', t => {
  environment(t, { GRAMPUS_CODEX_COMMAND: process.execPath, GRAMPUS_CLAUDE_COMMAND: undefined });
  const codex = codexExecutable();
  assert.deepEqual(
    { path: codex.path, command: codex.command, source: codex.source, problem: codex.problem },
    { path: process.execPath, command: process.execPath, source: 'environment', problem: null },
  );
  const bundled = claudeExecutable();
  assert.equal(bundled.source, 'bundled');
  if (process.platform === 'win32' && process.arch === 'x64')
    assert.match(bundled.path ?? '', /claude-agent-sdk-win32-x64[\\/]claude\.exe$/);
  // The node override stands in for a provider: its --version is what gets recorded.
  assert.deepEqual(providerRuntime('codex'), {
    executable: process.execPath,
    source: 'environment',
    version: process.versions.node,
    sdkVersion: null,
  });
  assert.equal(normaliseVersion('codex-cli 0.163.0\n'), '0.163.0');
  assert.equal(normaliseVersion('2.1.302 (Claude Code)'), '2.1.302');
  const store = journal(t);
  const session = new Sessions(store).create('codex', tmpdir());
  assert.deepEqual(store.session(session.id).runtime, providerRuntime('codex'));
  environment(t, { GRAMPUS_CLAUDE_COMMAND: process.execPath });
  const claude = new Sessions(store).create('claude', tmpdir());
  assert.equal(store.session(claude.id).runtime.sdkVersion, claudeSdk().version);
  assert.equal(store.session(claude.id).runtime.version, process.versions.node);
});

test(
  'PATH search finds native Codex executables only and explains an npm shim',
  { skip: process.platform !== 'win32' },
  t => {
    const shims = directory(t);
    writeFileSync(join(shims, 'codex.cmd'), '@echo off\r\n');
    environment(t, { GRAMPUS_CODEX_COMMAND: undefined, PATH: shims });
    const missing = codexExecutable();
    assert.equal(missing.path, null);
    assert.equal(missing.command, 'codex');
    assert.match(missing.problem ?? '', /script shim .*codex\.cmd.*GRAMPUS_CODEX_COMMAND/);
    assert.equal(providerRuntime('codex').version, null);
    const native = directory(t);
    writeFileSync(join(native, 'codex.exe'), ''); // Found by name and type; never run here.
    environment(t, { PATH: `${shims};${native}` });
    assert.equal(codexExecutable().path, join(native, 'codex.exe'));
    environment(t, { GRAMPUS_CODEX_COMMAND: join(native, 'absent.exe') });
    assert.match(codexExecutable().problem ?? '', /GRAMPUS_CODEX_COMMAND names .*absent\.exe/);
  },
);

test('integration status ignores untested rows and details are sanitised and bounded', () => {
  assert.equal(integrationStatus([]), 'untested');
  assert.equal(
    integrationStatus([
      { name: 'executable', status: 'healthy', detail: '' },
      { name: 'inference', status: 'untested', detail: '' },
    ]),
    'healthy',
  );
  assert.equal(
    integrationStatus([
      { name: 'handshake', status: 'temporarily_unavailable', detail: '' },
      { name: 'auth', status: 'auth_unavailable', detail: '' },
    ]),
    'auth_unavailable',
  );
  const detail = sanitiseDetail(
    `Signed in as someone@example.com with token=abc123 and Bearer xyz, id 36ba7ad4-639a-4401-9c6c-0b1d7ea74fe0\n${'x '.repeat(400)}`,
  );
  assert.doesNotMatch(detail, /someone@example\.com|abc123|xyz|36ba7ad4/);
  assert.match(detail, /<email>.*token=<redacted>.*Bearer <redacted>/);
  assert.ok(detail.length <= 240 && detail.endsWith('…'));
});

test('the latest health is stored, validated on read, compacted for polls and refreshed only when stale', async t => {
  const store = journal(t);
  const path = store.path;
  assert.equal(healthView(store).status, 'unknown');
  const checkedAt = '2026-10-19T10:00:00.000Z';
  let calls = 0;
  const check = async () => {
    calls++;
    return report(checkedAt, [
      integration({ id: 'codex' }),
      integration({
        id: 'orca',
        required: false,
        status: 'not_configured',
        capabilities: [{ name: 'executable', status: 'not_configured', detail: 'absent' }],
      }),
    ]);
  };
  const interval = currentSettings().healthCheckIntervalMs;
  const at = Date.parse(checkedAt);
  assert.ok(await refreshHealthIfStale(store, check, at));
  assert.equal(await refreshHealthIfStale(store, check, at + interval - 1), null, 'a fresh result is kept');
  assert.equal(calls, 1);
  const view = healthView(store, at + 1);
  assert.equal(view.status, 'healthy', 'an optional integration that is not configured needs no attention');
  assert.equal(view.stale, false);
  assert.equal(healthView(store, at + interval).stale, true);
  assert.deepEqual(store.health(), await check());
  assert.equal('executable' in (compactHealth(view).integrations[0] ?? {}), false, 'polls carry no paths');
  // A shared monitor runs one check for concurrent callers.
  const monitor = new HealthMonitor(store, check, () => at + interval);
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refreshIfStale()]);
  assert.equal(calls, 3, 'one refresh for both callers, plus the comparison report above');
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE health SET state = ? WHERE id = 'latest'").run(JSON.stringify({ checkedAt: 7 }));
  } finally {
    db.close();
  }
  assert.throws(
    () => store.health(),
    (error: unknown) => error instanceof BoundaryError && error.kind === 'journal-record' && error.source === 'health',
  );
});

/** A delivered task whose sessions ran the given provider runtimes. */
function deliveredTask(store: Store, runtimes: Session['runtime'][]): void {
  const taskId = randomUUID(),
    workspaceId = randomUUID();
  store.transaction(() => {
    store.save(taskId, { id: taskId, version: 1 });
    store.saveWorkspace(workspaceId, taskId, workspaceId, { id: workspaceId } as never);
    runtimes.forEach((runtime, index) => {
      const session: Session = {
        id: randomUUID(),
        provider: index === 0 ? 'codex' : 'claude',
        runtime,
        providerSessionId: null,
        model: null,
        cwd: tmpdir(),
        phase: 'idle',
        lastReply: null,
        run: null,
      };
      store.saveSession(session.id, session);
      const executionId = randomUUID();
      store.saveExecution(executionId, taskId, workspaceId, session.id, { id: executionId } as never);
      if (index === 0) store.saveDelivery(randomUUID(), executionId, { phase: 'delivered', executionId } as never);
    });
  });
}

test('a provider version that differs from the last successful delivery is a warning, never a block', t => {
  const store = journal(t);
  const current = report(new Date().toISOString(), [
    integration({ id: 'codex', version: '0.163.0' }),
    integration({ id: 'claude', version: '2.1.302', sdkVersion: '0.3.302' }),
  ]);
  store.saveHealth(current);
  assert.deepEqual(healthView(store).warnings, [], 'no delivery yet, nothing to compare');
  deliveredTask(store, [
    { executable: 'C:\\codex.exe', source: 'path', version: '0.162.0', sdkVersion: null },
    { executable: 'C:\\claude.exe', source: 'bundled', version: '2.1.302', sdkVersion: '0.3.300' },
  ]);
  const view = healthView(store);
  assert.deepEqual(view.warnings, [
    'Codex changed from 0.162.0 to 0.163.0 since the last successful delivery; capabilities are untested on this version.',
    'Claude Agent SDK changed from 0.3.300 to 0.3.302 since the last successful delivery; capabilities are untested on this version.',
  ]);
  assert.equal(view.status, 'attention');
  assert.deepEqual(
    versionWarnings(current, [
      {
        id: 's',
        provider: 'codex',
        runtime: { executable: null, source: 'path', version: null, sdkVersion: null },
        providerSessionId: null,
        model: null,
        cwd: tmpdir(),
        phase: 'idle',
        lastReply: null,
        run: null,
      },
    ]),
    [],
    'an unknown earlier version is not compared',
  );
  // The newest delivery is the baseline: delivering on the current versions clears the warning.
  deliveredTask(store, [
    { executable: 'C:\\codex.exe', source: 'path', version: '0.163.0', sdkVersion: null },
    { executable: 'C:\\claude.exe', source: 'bundled', version: '2.1.302', sdkVersion: '0.3.302' },
  ]);
  assert.deepEqual(healthView(store).warnings, []);
  assert.equal(healthView(store).status, 'healthy');
});

test('refreshHealth stores exactly what the check returned', async t => {
  const store = journal(t);
  const result = report('2026-10-19T11:00:00.000Z', [integration({ id: 'git' })]);
  assert.deepEqual(await refreshHealth(store, async () => result), result);
  assert.deepEqual(store.health(), result);
});
