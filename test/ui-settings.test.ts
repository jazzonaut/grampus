// Dashboard settings surface: `GET /api/v1/settings` describes config.json as an editable form, and
// `POST /api/settings` saves it, refusing stale revisions and invalid values. Without a settings
// directory the form is disabled and saving is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUi } from '../src/server/ui-server.js';
import { settingsFileName } from '../src/config/settings.js';
import type { ErrorV1, SettingsV1 } from '../src/server/api-types.js';

async function dashboard(t: { after(fn: () => Promise<void>): void }, withSettings = true) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-settings-'));
  const ui = await startUi({
    db: join(root, 'grampus.sqlite'),
    port: 0,
    ...(withSettings ? { settingsDirectory: root } : {}),
  });
  t.after(async () => {
    await ui.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = new URL(ui.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  return {
    file: join(root, settingsFileName),
    settings: async () => (await (await fetch(`${url.origin}/api/v1/settings`, { headers })).json()) as SettingsV1,
    save: (body: unknown) =>
      fetch(`${url.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

test('the settings form starts empty without config.json and a save writes only the given keys', async t => {
  const api = await dashboard(t);
  const before = await api.settings();
  assert.equal(before.file, api.file);
  assert.equal(before.restartRequired, false);
  assert.equal(before.problem, null);
  assert.equal(before.save.enabled, true);
  assert.deepEqual(before.save.request, {
    method: 'POST',
    path: '/api/settings',
    body: { expected: 'absent', overrides: {} },
  });
  const concurrency = before.save.form?.fields.find(field => field.name === 'maxConcurrentTasks');
  assert.equal(concurrency?.value, null);
  assert.equal(concurrency?.placeholder, 'Default 2');
  assert.equal(concurrency?.target, '/overrides/maxConcurrentTasks');
  const access = before.save.form?.fields.find(field => field.name === 'dashboardRequireAccessLink');
  assert.equal(access?.target, '/overrides/dashboardRequireAccessLink');
  assert.deepEqual(
    access?.options.map(option => option.value),
    [null, false, true],
  );

  const saved = await api.save({
    expected: 'absent',
    overrides: { maxConcurrentTasks: 3, dashboardRequireAccessLink: true },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(api.file, 'utf8')), {
    maxConcurrentTasks: 3,
    dashboardRequireAccessLink: true,
  });

  const after = await api.settings();
  assert.equal(after.restartRequired, true, 'the running dashboard still uses the settings it started with');
  assert.notEqual(after.save.expected, 'absent');
  assert.equal(after.save.form?.fields.find(field => field.name === 'maxConcurrentTasks')?.value, 3);
  assert.equal(after.save.form?.fields.find(field => field.name === 'dashboardRequireAccessLink')?.value, true);
});

test('a save is refused when config.json changed since it was shown, or when a value is out of range', async t => {
  const api = await dashboard(t);
  const shown = (await api.settings()).save.expected;
  writeFileSync(api.file, JSON.stringify({ dashboardPort: 4400 }));
  const stale = await api.save({ expected: shown, overrides: { maxConcurrentTasks: 3 } });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as ErrorV1).error.code, 'stale_state');
  assert.deepEqual(JSON.parse(readFileSync(api.file, 'utf8')), { dashboardPort: 4400 });

  const current = await api.settings();
  assert.equal(current.save.form?.fields.find(field => field.name === 'dashboardPort')?.value, 4400);
  const invalid = await api.save({ expected: current.save.expected, overrides: { maxConcurrentTasks: 9 } });
  assert.equal(invalid.status, 400);
  assert.match(((await invalid.json()) as ErrorV1).error.message, /"maxConcurrentTasks"/);
  const missing = await api.save({ expected: current.save.expected });
  assert.equal(missing.status, 400);
});

test('an invalid config.json is reported and can be replaced from the form', async t => {
  const api = await dashboard(t);
  writeFileSync(api.file, JSON.stringify({ maxConcurrentTasks: 9 }));
  const shown = await api.settings();
  assert.match(shown.problem ?? '', /"maxConcurrentTasks"/);
  assert.equal(shown.restartRequired, false);
  const saved = await api.save({ expected: shown.save.expected, overrides: {} });
  assert.equal(saved.status, 200);
  assert.equal((await api.settings()).problem, null);
});

test('without a settings directory the form is disabled and saving is refused', async t => {
  const api = await dashboard(t, false);
  const shown = await api.settings();
  assert.equal(shown.file, null);
  assert.equal(shown.save.enabled, false);
  assert.ok(shown.save.disabledReason);
  const refused = await api.save({ expected: '', overrides: {} });
  assert.equal(refused.status, 409);
});
