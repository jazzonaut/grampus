// Integration health: executable resolution shared with the adapters, the provider runtime recorded on
// sessions, the stored and validated health record, staleness, and the provider version change warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/persistence/store.js';
import { taskRecord } from './helpers/task-records.js';
import { Sessions } from '../src/execution/sessions.js';
import { BoundaryError } from '../src/process/boundary.js';
import {
  claudeExecutable,
  claudeSdk,
  codexExecutable,
  findExecutable,
  normaliseVersion,
  npmVendoredCodex,
  providerRuntime,
} from '../src/providers/executables.js';
import {
  HealthMonitor,
  healthView,
  integrationStatus,
  refreshHealth,
  refreshHealthIfStale,
  sanitiseDetail,
  versionWarnings,
} from '../src/health/health.js';
import type { HealthReport, IntegrationHealth } from '../src/health/health-record.js';
import { doctor } from '../src/health/doctor.js';
import type { Session } from '../src/persistence/records.js';
import { currentSettings } from '../src/config/settings.js';
import { applicationRoot } from '../src/config/runtime.js';

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

const applyEnvironment = (entries: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(entries))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
};
/** The values each test found before its first override of a variable. */
const originalEnvironment = new WeakMap<object, Record<string, string | undefined>>();

/**
 * Set environment variables for one test and restore them afterwards. A variable set twice in one test
 * is restored to the value before the first override, whatever order the `after` hooks run in.
 */
function environment(t: { after: (fn: () => void) => void }, values: Record<string, string | undefined>) {
  let original = originalEnvironment.get(t);
  if (!original) {
    const saved: Record<string, string | undefined> = {};
    original = saved;
    originalEnvironment.set(t, saved);
    t.after(() => applyEnvironment(saved));
  }
  for (const key of Object.keys(values)) if (!Object.hasOwn(original, key)) original[key] = process.env[key];
  applyEnvironment(values);
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
  'Codex is the binary the pinned npm package vendors, never a codex on PATH',
  { skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) },
  t => {
    // A native codex.exe on PATH, as a standalone or desktop install leaves, is ignored.
    const native = directory(t);
    fakeExecutable(native, 'codex.exe');
    environment(t, { GRAMPUS_CODEX_COMMAND: undefined, PATH: native });
    const codex = codexExecutable();
    assert.equal(codex.source, 'bundled');
    assert.equal(codex.problem, null);
    assert.match(codex.path ?? '', /node_modules[\\/]@openai[\\/]codex-win32-(x64|arm64)[\\/]vendor[\\/].*codex\.exe$/);
    assert.equal(codex.command, codex.path);
    const manifest = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const pinned = manifest.dependencies['@openai/codex'];
    assert.equal(providerRuntime('codex').version, pinned, 'the vendored binary reports the pinned version');
    environment(t, { GRAMPUS_CODEX_COMMAND: join(native, 'absent.exe') });
    assert.match(codexExecutable().problem ?? '', /GRAMPUS_CODEX_COMMAND names .*absent\.exe/);
  },
);

/** Write an empty file that resolution accepts as executable; it is found by path and type, never run. */
function fakeExecutable(...segments: string[]): string {
  const path = join(...segments);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '', { mode: 0o755 });
  return path;
}

/** The `vendor` folder of an npm Codex package under the global prefix `prefix`. */
const vendorOf = (prefix: string, ...packagePath: string[]) => [
  prefix,
  'node_modules',
  '@openai',
  ...packagePath,
  'vendor',
];
/** The current npm layout: the platform package nested in `@openai/codex`. */
const nestedVendor = (prefix: string, arch: string) =>
  vendorOf(prefix, 'codex', 'node_modules', '@openai', `codex-win32-${arch}`);

test('the native Codex binary an npm installation vendors is found by fixed paths, never by its shim', t => {
  const current = directory(t);
  const binary = fakeExecutable(...nestedVendor(current, 'x64'), 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(npmVendoredCodex(current, 'x64'), binary);
  assert.equal(npmVendoredCodex(current, 'arm64'), null, 'only the running architecture is looked for');
  assert.equal(npmVendoredCodex(current, 'ia32'), null);
  // A codex/ folder in place of bin/, and a flattened platform package beside @openai/codex.
  const folder = directory(t);
  const inFolder = fakeExecutable(...nestedVendor(folder, 'arm64'), 'aarch64-pc-windows-msvc', 'codex', 'codex.exe');
  assert.equal(npmVendoredCodex(folder, 'arm64'), inFolder);
  const flattened = directory(t);
  const flat = fakeExecutable(...vendorOf(flattened, 'codex-win32-x64'), 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(npmVendoredCodex(flattened, 'x64'), flat);
  // The nested package wins over a flattened one, as Node's resolution from @openai/codex does.
  fakeExecutable(...vendorOf(current, 'codex-win32-x64'), 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(npmVendoredCodex(current, 'x64'), binary);
  // npm's staging folder from an interrupted install is never used, and a relative prefix is refused.
  const staging = directory(t);
  // The layout npm leaves behind: @openai/.codex-<random>/node_modules/@openai/codex-win32-x64/vendor/...
  const stagedPackage = ['.codex-DbAZUee8', 'node_modules', '@openai', 'codex-win32-x64'];
  fakeExecutable(...vendorOf(staging, ...stagedPackage), 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fakeExecutable(...vendorOf(staging, '.codex-DbAZUee8'), 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(npmVendoredCodex(staging, 'x64'), null);
  assert.equal(npmVendoredCodex('relative-prefix', 'x64'), null);
});

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
    store.save(taskId, taskRecord(taskId));
    store.saveWorkspace(workspaceId, taskId, workspaceId, { id: workspaceId } as never);
    runtimes.forEach((runtime, index) => {
      const session: Session = {
        id: randomUUID(),
        provider: index === 0 ? 'codex' : 'claude',
        runtime,
        providerSessionId: null,
        model: null,
        requestedModel: null,
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
        requestedModel: null,
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

test(
  'doctor records a provider that cannot be started as a failed row instead of rejecting',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = directory(t);
    // Node refuses to start a batch file without a shell, synchronously, as spawn EINVAL.
    const script = join(root, 'codex.cmd');
    writeFileSync(script, '@echo off\r\necho codex-cli 1.0.0\r\n');
    environment(t, {
      GRAMPUS_CODEX_COMMAND: script,
      GRAMPUS_CLAUDE_COMMAND: join(root, 'absent-claude.exe'),
      ORCA_CLI_COMMAND: join(root, 'absent-orca.exe'),
    });
    const report = await doctor();
    const codex = report.integrations.find(item => item.id === 'codex')!;
    assert.equal(codex.status, 'failed');
    assert.deepEqual(
      codex.capabilities.map(row => [row.name, row.status]),
      [
        ['executable', 'healthy'],
        ['version', 'failed'],
        ['handshake', 'failed'],
        ['auth', 'untested'],
        ['mcp', 'untested'],
        ['inference', 'untested'],
      ],
    );
    assert.match(codex.capabilities.find(row => row.name === 'handshake')!.detail, /EINVAL/);
    const git = report.integrations.find(item => item.id === 'git')!;
    assert.equal(git.executable, findExecutable('git'));
    assert.equal(git.capabilities[0]?.detail, findExecutable('git'));
  },
);
