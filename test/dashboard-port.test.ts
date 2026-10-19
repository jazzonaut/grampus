// The dashboard port: browsers (and Node's fetch) refuse the WHATWG "bad ports", so an ephemeral port
// on that list is exchanged for another, and an explicitly requested one is refused before listening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserRefusesPort, listenForBrowsers } from '../src/server/browser-ports.js';
import { startUi } from '../src/server/ui-server.js';

/** A server whose operating system assigns `ports` in turn for port 0. */
function assigning(ports: number[]) {
  const listened: number[] = [];
  let closed = 0,
    current = 0;
  const server = Object.assign(new EventEmitter(), {
    listen(port: number, _host: string, ready: () => void) {
      current = port || (ports.shift() ?? 0);
      listened.push(current);
      setImmediate(ready);
    },
    address: () => ({ port: current, address: '127.0.0.1', family: 'IPv4' }),
    close(done: (error?: Error) => void) {
      closed++;
      setImmediate(done);
    },
  });
  return { server: server as unknown as Server, listened, closed: () => closed };
}

test('the bad port list matches what fetch refuses', async () => {
  for (const port of [6000, 6665, 10080]) {
    assert.equal(browserRefusesPort(port), true);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), (error: Error) =>
      String((error.cause as Error | undefined)?.message ?? error.message).includes('bad port'),
    );
  }
  assert.equal(browserRefusesPort(4300), false);
});

test('an ephemeral port that browsers refuse is exchanged for another', async () => {
  const fake = assigning([6000, 10080, 51234]);
  assert.equal(await listenForBrowsers(fake.server, 0), 51234);
  assert.deepEqual(fake.listened, [6000, 10080, 51234]);
  assert.equal(fake.closed(), 2);
  const stubborn = assigning(Array.from({ length: 100 }, () => 6000));
  await assert.rejects(listenForBrowsers(stubborn.server, 0), /ports browsers refuse/);
});

test('an explicitly requested port that browsers refuse is refused before listening', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startUi({ db: join(root, 'grampus.sqlite'), port: 6000 }), /Browsers refuse port 6000/);
  const fake = assigning([]);
  await assert.rejects(listenForBrowsers(fake.server, 6000), /Browsers refuse port 6000/);
  assert.deepEqual(fake.listened, []);
});
