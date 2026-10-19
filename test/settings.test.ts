// Settings tests: config.json defaults, overrides, strict validation, per-process injection and saving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentSettings,
  defaultSettings,
  loadSettings,
  parseSettings,
  readSettingsFile,
  saveSettingsFile,
  settingsFileName,
  useSettings,
} from '../src/config/settings.js';
import { defaultDashboardPort } from '../src/config/runtime.js';
import { normalizeGuidedPlan } from '../src/domain/guided-plan.js';
import { normalizeWorkflowPolicy } from '../src/domain/workflow-policy.js';
import { StaleStateError } from '../src/persistence/errors.js';

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
    liveChangesIntervalMs: 5000,
    outputFlushIntervalMs: 1000,
    outputFlushBytes: 8192,
    defaultPreparationTimeoutMs: 600_000,
    defaultCheckTimeoutMs: 300_000,
    defaultWorkflowPolicy: { mode: 'automatic', repairRounds: 3, maxSessionTurns: 6, maxContextTokens: 120_000 },
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
    { defaultWorkflowPolicy: { repairRounds: 11 } },
    { defaultWorkflowPolicy: { mode: 'unattended' } },
    { maxConcurrentTasks: 0 },
    { maxConcurrentTasks: 5 },
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

test('the output flush interval must be shorter than the stall warning, including against a default', t => {
  for (const config of [
    { outputFlushIntervalMs: 5000, stallWarningMs: 5000 },
    { outputFlushIntervalMs: 20_000, stallWarningMs: 10_000 },
    { stallWarningMs: 1000 },
  ])
    assert.throws(
      () => loadSettings(dataDirectory(t, config)),
      /"outputFlushIntervalMs": must be shorter than stallWarningMs/,
      JSON.stringify(config),
    );
  assert.equal(loadSettings(dataDirectory(t, { stallWarningMs: 1001 })).stallWarningMs, 1001);
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

test('saving writes exactly the given overrides, which the next load merges over the defaults', t => {
  const root = join(dataDirectory(t), 'created');
  const absent = readSettingsFile(root);
  assert.equal(absent.revision, 'absent');
  assert.deepEqual(absent.settings, defaultSettings());
  saveSettingsFile(root, { maxConcurrentTasks: 3, defaultWorkflowPolicy: { mode: 'supervised' } }, absent.revision);
  assert.deepEqual(JSON.parse(readFileSync(join(root, settingsFileName), 'utf8')), {
    maxConcurrentTasks: 3,
    defaultWorkflowPolicy: { mode: 'supervised' },
  });
  assert.deepEqual(readdirSync(root), [settingsFileName], 'no temporary file is left behind');
  const saved = readSettingsFile(root);
  assert.notEqual(saved.revision, 'absent');
  assert.equal(saved.problem, null);
  assert.deepEqual(loadSettings(root), {
    ...defaultSettings(),
    maxConcurrentTasks: 3,
    defaultWorkflowPolicy: { ...defaultSettings().defaultWorkflowPolicy, mode: 'supervised' },
  });
  saveSettingsFile(root, {}, saved.revision);
  assert.deepEqual(loadSettings(root), defaultSettings());
});

test('saving refuses invalid overrides and a file changed since it was read, leaving the file alone', t => {
  const root = dataDirectory(t, { dashboardPort: 4400 });
  const path = join(root, settingsFileName);
  const shown = readSettingsFile(root).revision;
  assert.throws(() => saveSettingsFile(root, { maxConcurrentTasks: 9 }, shown), /"maxConcurrentTasks"/);
  assert.throws(() => saveSettingsFile(root, { dashbordPort: 1 }, shown), /unknown key "dashbordPort"/);
  writeFileSync(path, JSON.stringify({ dashboardPort: 4401 }));
  assert.throws(() => saveSettingsFile(root, { dashboardPort: 4402 }, shown), StaleStateError);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { dashboardPort: 4401 });
});

test('reading reports an invalid file instead of throwing, so it can be shown and replaced', t => {
  const broken = readSettingsFile(dataDirectory(t, '{ not json'));
  assert.equal(broken.settings, null);
  assert.equal(broken.stored, undefined);
  assert.match(broken.problem ?? '', /Invalid settings in .*config\.json/);
  const refused = readSettingsFile(dataDirectory(t, { maxConcurrentTasks: 9 }));
  assert.equal(refused.settings, null);
  assert.deepEqual(refused.stored, { maxConcurrentTasks: 9 });
  assert.match(refused.problem ?? '', /"maxConcurrentTasks"/);
});

test('new plans default preparation and checks to separate timeouts, each configurable', t => {
  const root = dataDirectory(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Initial');
  const command = { file: 'node', args: ['-e', ''] };
  const plan = () =>
    normalizeGuidedPlan({
      brief: { title: 'Timeouts', outcome: 'Timeouts', criteria: ['Timeouts'], plan: 'Check timeouts' },
      workspace: { repo, path: join(root, 'workspace') },
      preparation: command,
      slices: [
        {
          scope: { files: ['a.txt'] },
          preparation: command,
          validation: command,
          acceptance: { ...command, expectedStdout: '' },
          message: 'Timeouts',
        },
      ],
    });
  const timeouts = () => {
    const { preparation, slices } = plan();
    const [slice] = slices;
    return [
      preparation?.timeoutMs,
      slice?.preparation?.timeoutMs,
      slice?.validation.timeoutMs,
      slice?.acceptance.timeoutMs,
    ];
  };
  t.after(() => useSettings(defaultSettings()));
  useSettings(defaultSettings());
  assert.deepEqual(timeouts(), [600_000, 600_000, 300_000, 300_000]);
  useSettings({ ...defaultSettings(), defaultPreparationTimeoutMs: 90_000, defaultCheckTimeoutMs: 45_000 });
  assert.deepEqual(timeouts(), [90_000, 90_000, 45_000, 45_000]);
  assert.throws(
    () => loadSettings(dataDirectory(t, { defaultPreparationTimeoutMs: 600_001 })),
    /"defaultPreparationTimeoutMs"/,
  );
});
