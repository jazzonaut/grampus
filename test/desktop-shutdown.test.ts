// A native shutdown request follows the dashboard's existing origin, bearer and settlement guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { desktopFiles, desktopProfile, desktopRequest } from '../src/server/desktop-discovery.js';
import { startUi } from '../src/server/ui-server.js';
import { fixture } from './helpers/guided-tasks.js';
import { connect, offered, settled } from './helpers/dashboard.js';

test('a request awaiting its body cannot create a task after native shutdown is accepted', async t => {
  const f = fixture(t);
  const ui = await startUi({ db: f.store.path, port: 0, desktop: desktopProfile(f.root, f.store.path) });
  const api = connect(ui);
  const body = JSON.stringify({ plan: f.plan });
  const received = new Promise<void>(resolve => {
    ui.server.once('request', () => setImmediate(resolve));
  });
  let pending: ReturnType<typeof request> | undefined;
  try {
    const result = new Promise<number | undefined>((resolve, reject) => {
      pending = request(
        `${api.origin}/api/tasks`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${api.token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      pending.once('error', reject);
      pending.flushHeaders();
    });
    await received;
    await desktopRequest(ui.endpoint!, true);
    pending!.end(body);
    assert.equal(await result, 503);
    await ui.close();
    assert.equal(f.store.list().length, 0);
  } finally {
    pending?.destroy();
    await ui.close();
  }
});

test('native shutdown refuses foreign origins, stale instances and active work, then retires discovery', async t => {
  const f = fixture(t);
  const id = f.create();
  const profile = desktopProfile(f.root, f.store.path);
  const ui = await startUi({ db: f.store.path, port: 0, desktop: profile });
  try {
    const api = connect(ui);
    const path = '/api/desktop/close';
    const endpoint = ui.endpoint!;
    const unauthorised = await fetch(api.origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: endpoint.instance }),
    });
    assert.equal(unauthorised.status, 401);
    const foreign = await fetch(api.origin + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://example.invalid',
      },
      body: JSON.stringify({ instance: endpoint.instance }),
    });
    assert.equal(foreign.status, 403);
    assert.equal((await api.post(path, { instance: 'stale' })).status, 409);
    const view = await api.task(id);
    assert.equal((await api.act(offered(view, 'run'))).status, 202);
    assert.equal((await api.post(path, { instance: endpoint.instance })).status, 409);
    assert.equal(existsSync(desktopFiles(profile).receipt), true);
    await settled(ui, id);
    await desktopRequest(endpoint, true);
    await ui.close();
    assert.equal(existsSync(desktopFiles(profile).receipt), false);
    assert.equal(f.store.get(id).guided?.status, 'awaiting_scope');
  } finally {
    await ui.close();
  }
});
