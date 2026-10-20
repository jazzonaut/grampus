// Owns real HTTP coverage for configurable LAN binding and interface-specific origin guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { currentSettings, loadSettings, parseSettings, useSettings } from '../src/config/settings.js';
import { startUi } from '../src/server/ui-server.js';

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(address => address?.family === 'IPv4' && !address.internal)?.address;

function status(url: string, headers: Record<string, string> = {}): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

for (const required of [false, true]) {
  test(`default LAN binding preserves origin and access checks with access link ${required}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-ui-lan-'));
    const previous = currentSettings();
    useSettings(parseSettings({ dashboardRequireAccessLink: required }, 'test'));
    const db = join(root, 'journal.sqlite');
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Grampus</title>');
    const ui = await startUi({
      db,
      port: 0,
      client: root,
      settingsDirectory: root,
      desktop: { directory: root, application: root, db },
    });
    t.after(async () => {
      await ui.close();
      useSettings(previous);
      rmSync(root, { recursive: true, force: true });
    });
    const address = ui.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '0.0.0.0');
    const local = new URL(ui.url);
    assert.equal(local.hostname, '127.0.0.1');
    assert.equal(new URL(ui.endpoint!.url!).hostname, '127.0.0.1');
    const token = new URL(ui.endpoint!.url!).hash.slice(1);
    const credentials = { Authorization: `Bearer ${token}` };
    const origins = [local.origin];
    if (lanAddress) origins.push(`http://${lanAddress}:${local.port}`);
    for (const origin of origins) {
      assert.equal(await status(`${origin}/`), 200);
      const api = `${origin}/api/v1/overview`;
      assert.equal(await status(api), required ? 401 : 200);
      assert.equal(await status(api, { ...credentials, Origin: origin }), 200);
      assert.equal(await status(api, { ...credentials, Origin: 'http://untrusted.example' }), 403);
      assert.equal(await status(api, { ...credentials, Host: `untrusted.example:${local.port}` }), 403);
      assert.equal(await status(api, { ...credentials, Host: `${new URL(origin).hostname}:1` }), 403);
      assert.equal(await status(api, { ...credentials, 'Sec-Fetch-Site': 'cross-site' }), 403);
      assert.equal(await status(`${origin}/api/desktop`), 401);
      assert.equal(await status(`${origin}/api/desktop`, credentials), 200);
    }
    const saved = await fetch(`${origins.at(-1)!}/api/settings`, {
      method: 'POST',
      headers: { ...credentials, Origin: origins.at(-1)!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected: 'absent', overrides: { dashboardListenOnLan: false } }),
    });
    await saved.arrayBuffer();
    assert.equal(saved.status, 200);
    assert.equal(loadSettings(root).dashboardListenOnLan, false);
    assert.deepEqual(ui.server.address(), address, 'saved settings apply only after restart');
  });
}

test('disabling LAN access binds only to IPv4 loopback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-loopback-'));
  const previous = currentSettings();
  useSettings(parseSettings({ dashboardListenOnLan: false }, 'test'));
  const ui = await startUi({ db: join(root, 'journal.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    useSettings(previous);
    rmSync(root, { recursive: true, force: true });
  });
  const address = ui.server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  const local = new URL(ui.url);
  assert.equal(await status(`${local.origin}/api/v1/overview`), 200);
  assert.equal(await status(`${local.origin}/api/v1/overview`, { Host: `untrusted.example:${local.port}` }), 403);
});
