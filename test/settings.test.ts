// Settings tests: config.json defaults, overrides, strict validation and per-process injection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentSettings,
  defaultSettings,
  loadSettings,
  parseSettings,
  settingsFileName,
  useSettings,
} from '../src/config/settings.js';
import { defaultDashboardPort } from '../src/config/runtime.js';
import { normalizeWorkflowPolicy } from '../src/domain/workflow-policy.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function dataDirectory(t: { after: (fn: () => void) => void }, config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'grampus-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (config !== undefined)
    writeFileSync(join(root, settingsFileName), typeof config === 'string' ? config : JSON.stringify(config));
  return root;
}

test('without config.json the built-in defaults apply and nothing is created', t => {
  const root = join(dataDirectory(t), 'absent');
  const settings = loadSettings(root);
  assert.deepEqual(settings, {
    dashboardPort: defaultDashboardPort,
    usagePollIntervalMs: 15_000,
    defaultCheckTimeoutMs: 120_000,
    defaultWorkflowPolicy: { mode: 'automatic', repairRounds: 2, maxSessionTurns: 6, maxContextTokens: 120_000 },
    qualityPasses: [],
    defaultQualityPasses: ['simplification'],
    maxConcurrentTasks: 2,
    stallWarningMs: 600_000,
    healthCheckIntervalMs: 600_000,
  });
  assert.deepEqual(settings, defaultSettings());
  assert.equal(existsSync(root), false);
});

test('a valid partial override merges over the defaults, including the nested workflow policy', t => {
  const root = dataDirectory(t, {
    dashboardPort: 4400,
    usagePollIntervalMs: 5000,
    defaultCheckTimeoutMs: 300_000,
    defaultWorkflowPolicy: { repairRounds: 1, mode: 'supervised' },
  });
  assert.deepEqual(loadSettings(root), {
    ...defaultSettings(),
    dashboardPort: 4400,
    usagePollIntervalMs: 5000,
    defaultCheckTimeoutMs: 300_000,
    defaultWorkflowPolicy: { mode: 'supervised', repairRounds: 1, maxSessionTurns: 6, maxContextTokens: 120_000 },
  });
  assert.deepEqual(loadSettings(dataDirectory(t, {})), defaultSettings());
});

test('unknown keys are refused with the file and the key named, at the top level and nested', t => {
  const root = dataDirectory(t, { dashbordPort: 4400 });
  const path = join(root, settingsFileName);
  assert.throws(
    () => loadSettings(root),
    (error: Error) => error.message.includes(path) && error.message.includes('unknown key "dashbordPort"'),
  );
  assert.throws(
    () => loadSettings(dataDirectory(t, { defaultWorkflowPolicy: { repairRound: 1 } })),
    /unknown key "defaultWorkflowPolicy\.repairRound"/,
  );
});

test('invalid types, out-of-range values and malformed JSON are refused with the file named', t => {
  for (const config of [
    { dashboardPort: '4400' },
    { usagePollIntervalMs: 2.5 },
    { defaultCheckTimeoutMs: 600_001 },
    { defaultWorkflowPolicy: { repairRounds: 6 } },
    { defaultWorkflowPolicy: { mode: 'unattended' } },
    { maxConcurrentTasks: 0 },
    { healthCheckIntervalMs: 999 },
    [],
    null,
  ]) {
    const root = dataDirectory(t, config);
    assert.throws(
      () => loadSettings(root),
      (error: Error) => error.message.startsWith(`Invalid settings in ${join(root, settingsFileName)}: `),
      JSON.stringify(config),
    );
  }
  assert.throws(() => loadSettings(dataDirectory(t, { dashboardPort: '4400' })), /"dashboardPort"/);
  const malformed = dataDirectory(t, '{ "dashboardPort": ');
  assert.throws(
    () => loadSettings(malformed),
    (error: Error) => error.message.startsWith(`Invalid settings in ${join(malformed, settingsFileName)}: `),
  );
});

test('injected settings supply new-plan defaults and a worker round trip keeps them exact', t => {
  const injected = {
    ...defaultSettings(),
    defaultWorkflowPolicy: { mode: 'supervised' as const, repairRounds: 0, maxSessionTurns: 3, maxContextTokens: 9000 },
  };
  t.after(() => useSettings(defaultSettings()));
  useSettings(injected);
  assert.deepEqual(normalizeWorkflowPolicy(undefined), injected.defaultWorkflowPolicy);
  assert.deepEqual(normalizeWorkflowPolicy({ repairRounds: 4 }), {
    ...injected.defaultWorkflowPolicy,
    repairRounds: 4,
  });
  assert.throws(() => {
    (currentSettings() as { dashboardPort: number }).dashboardPort = 1;
  }, TypeError);
  assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(currentSettings())), 'a worker request'), injected);
});

test('custom quality passes and default selections are validated against the built-ins', t => {
  const custom = {
    id: 'error-handling',
    title: 'Error handling',
    kind: 'lens',
    instructions: 'Assess whether every new failure path is reported with enough context to act on.',
  };
  const loaded = loadSettings(
    dataDirectory(t, { qualityPasses: [custom], defaultQualityPasses: ['naming', 'error-handling'] }),
  );
  assert.deepEqual(loaded.qualityPasses, [custom]);
  assert.deepEqual(loaded.defaultQualityPasses, ['naming', 'error-handling']);
  assert.deepEqual(loadSettings(dataDirectory(t, { defaultQualityPasses: [] })).defaultQualityPasses, []);
  const refused: [unknown, RegExp][] = [
    [{ qualityPasses: [{ ...custom, id: 'naming' }] }, /"qualityPasses\.0\.id": "naming" is a built-in/],
    [{ qualityPasses: [custom, custom] }, /duplicate quality pass "error-handling"/],
    [{ qualityPasses: [{ ...custom, id: 'Error Handling' }] }, /kebab-case/],
    [{ qualityPasses: [{ ...custom, kind: 'fix' }] }, /"qualityPasses\.0\.kind"/],
    [{ qualityPasses: [{ ...custom, instructions: 'x'.repeat(5000) }] }, /at most 4096 bytes/],
    [{ qualityPasses: [{ ...custom, extra: true }] }, /unknown key "qualityPasses\.0\.extra"/],
    [{ defaultQualityPasses: ['security'] }, /"defaultQualityPasses\.0": unknown quality pass "security"/],
    [{ defaultQualityPasses: ['naming', 'naming'] }, /duplicate quality pass "naming"/],
    [{ defaultQualityPasses: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, /"defaultQualityPasses"/],
  ];
  for (const [config, message] of refused)
    assert.throws(() => loadSettings(dataDirectory(t, config)), message, JSON.stringify(config));
});

test('the CLI loads config.json from the data directory once and refuses an invalid file', t => {
  const run = (home: string) =>
    execFileSync(process.execPath, [cli, 'version', '--json'], {
      env: { ...process.env, GRAMPUS_HOME: home },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  assert.equal(JSON.parse(run(dataDirectory(t, { dashboardPort: 4999 }))).dashboardPort, 4999);
  assert.equal(JSON.parse(run(dataDirectory(t))).dashboardPort, defaultDashboardPort);
  assert.throws(() => run(dataDirectory(t, { surprise: true })), /unknown key "surprise"/);
});
