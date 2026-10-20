// Owns dashboard access tests for default local access and opt-in per-launch links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSettings, parseSettings, useSettings } from '../src/config/settings.js';
import { startUi } from '../src/server/ui-server.js';

for (const required of [false, true]) {
  test(`dashboard access link requirement is ${required}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-ui-access-'));
    const previous = currentSettings();
    useSettings(parseSettings(required ? { dashboardRequireAccessLink: true } : {}, 'test'));
    const db = join(root, 'journal.sqlite');
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Grampus</title>');
    let queries = 0;
    const ui = await startUi({
      db,
      port: 0,
      client: root,
      desktop: { directory: root, application: root, db },
      providerModels: async () => {
        queries++;
        return { codex: { models: [], problem: null }, claude: { models: [], problem: null } };
      },
    });
    t.after(async () => {
      await ui.close();
      useSettings(previous);
      rmSync(root, { recursive: true, force: true });
    });
    const url = new URL(ui.url);
    assert.equal(url.hash !== '', required);
    assert.equal((await fetch(`${url.origin}/api/v1/overview`)).status, required ? 401 : 200);
    assert.equal(
      (await fetch(`${url.origin}/api/v1/overview`, { headers: { Authorization: 'Bearer stale-token' } })).status,
      required ? 401 : 200,
    );
    assert.equal(
      (await fetch(`${url.origin}/api/v1/overview`, { headers: { Origin: 'https://untrusted.example' } })).status,
      403,
    );
    assert.equal((await fetch(`${url.origin}/api/desktop`)).status, 401);
    // Following a dashboard link from another site must still load the local page.
    assert.equal((await fetch(ui.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
    assert.equal(
      (await fetch(`${url.origin}/api/v1/overview`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
      403,
    );
    assert.equal((await fetch(`${url.origin}/api/desktop/close`, { method: 'POST' })).status, 401);
    const privateUrl = new URL(ui.endpoint!.url!);
    const headers = { Authorization: `Bearer ${privateUrl.hash.slice(1)}` };
    assert.equal((await fetch(`${url.origin}/api/desktop`, { headers })).status, 200);
    assert.equal((await fetch(`${url.origin}/api/v1/overview`, { headers })).status, 200);
    assert.equal((await fetch(`${url.origin}/api/v1/provider-models`)).status, required ? 401 : 200);
    assert.equal(queries, required ? 0 : 1);
    assert.equal((await fetch(`${url.origin}/api/v1/provider-models`, { headers })).status, 200);
    assert.equal(queries, required ? 1 : 2);
  });
}
