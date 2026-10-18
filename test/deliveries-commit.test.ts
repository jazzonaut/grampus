// Delivery tests: supervised commits, gate and snapshot checks, timeouts and journal rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/persistence/store.js';
import { Workflow } from '../src/domain/workflow.js';
import { type Delivery } from '../src/execution/deliveries.js';
import { windows, git, fixture, noChangeFixture } from './helpers/deliveries.js';

test(
  'supervised delivery commits exact checked bytes, paths and executable modes then completes atomically',
  windows,
  async t => {
    const f = await fixture(t);
    const specFile = join(f.root, 'delivery.json');
    writeFileSync(specFile, JSON.stringify(f.spec));
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const result = JSON.parse(
      execFileSync(process.execPath, [cli, 'execution-deliver', f.execution.id, specFile, '--db', f.db], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ) as Delivery;
    assert.equal(result.phase, 'delivered', JSON.stringify(result));
    assert.equal(result.outcome, 'committed');
    assert.equal(result.commit, git(f.workspace.path, 'rev-parse', 'HEAD'));
    assert.equal(
      git(f.workspace.path, 'show', '-s', '--format=%an <%ae> / %cn <%ce>'),
      'Fixture <fixture@invalid> / Fixture <fixture@invalid>',
    );
    assert.match(git(f.workspace.path, 'ls-tree', 'HEAD', 'greeting.js'), /^100755/);
    assert.equal(git(f.workspace.path, 'status', '--porcelain'), '');
    assert.equal(f.workflow.get(f.task.id).phase, 'complete');
    assert.equal(f.store.lease(f.workspace.id), null);
    assert.ok(f.store.events(f.task.id).some(event => event.type === 'delivery.settled'));
    await assert.rejects(f.deliveries.run(f.execution.id, f.spec), /current submitted/);
  },
);

test('delivery rejects missing gates and stale snapshots before any Git write', windows, async t => {
  const f = await fixture(t);
  f.workflow.record(f.task.id, {
    id: 'new-review',
    kind: 'review',
    artifact: f.snapshot.artifact,
    attemptId: f.execution.attemptId,
    version: 1,
    outcome: 'failed',
    source: 'controller',
    summary: 'Blocking fixture finding',
    agent: { provider: 'claude', model: 'fixture', sessionId: 'other-review' },
  });
  await assert.rejects(f.deliveries.run(f.execution.id, f.spec), /review has not passed/);
  assert.deepEqual(f.store.deliveries(f.execution.id), []);
  const g = await fixture(t);
  writeFileSync(join(g.workspace.path, 'unreviewed.txt'), 'new content');
  const result = await g.deliveries.run(g.execution.id, g.spec);
  assert.equal(result.phase, 'failed');
  assert.equal(result.dispatch, 'not_requested');
  assert.equal(git(g.workspace.path, 'rev-parse', 'HEAD'), g.snapshot.head);
  assert.equal(g.store.lease(g.workspace.id), null);
});

test('Git normalization that changes reviewed bytes fails before commit and retains staged state', windows, async t => {
  const f = await fixture(t, path => {
    writeFileSync(join(path, '.gitattributes'), '*.txt text eol=lf\n');
    writeFileSync(join(path, 'normalized.txt'), 'one\r\ntwo\r\n');
  });
  const result = await f.deliveries.run(f.execution.id, f.spec);
  assert.equal(result.phase, 'failed');
  assert.match(result.result!.stderr, /bytes differ/);
  assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('hook changes cannot turn a different commit into accepted delivery', windows, async t => {
  const f = await fixture(t);
  const hooks = join(f.repo, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "unreviewed\\n" > hook.txt\ngit add hook.txt\n');
  const result = await f.deliveries.run(f.execution.id, f.spec);
  assert.equal(result.phase, 'failed');
  assert.notEqual(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.equal(result.commit, null);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('schema 7 migration retains evidence and adds empty delivery storage', windows, async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.db);
  db.exec('DROP TABLE deliveries; PRAGMA user_version = 7;');
  db.close();
  const migrated = new Store(f.db);
  try {
    assert.deepEqual(migrated.deliveries(f.execution.id), []);
    assert.equal(new Workflow(migrated).get(f.task.id).evidence.length, 4);
  } finally {
    migrated.close();
  }
});

test('delivery timeout confirms tool exit and leaves task incomplete without automatic rollback', windows, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 10\n');
  const result = await f.deliveries.run(f.execution.id, { ...f.spec, timeoutMs: 1200 });
  assert.equal(result.phase, 'failed');
  assert.equal(result.result?.reason, 'timed_out');
  assert.equal(result.result?.exitConfirmed, true);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
});

test('delivery completion and journal acceptance roll back together on a database failure', windows, async t => {
  for (const noChange of [false, true]) {
    const f = noChange ? await noChangeFixture(t) : await fixture(t);
    const append = f.store.append.bind(f.store);
    let fail = true;
    f.store.append = (id, version, type, data) => {
      if (type === 'delivery.settled' && fail) {
        fail = false;
        throw new Error('Injected journal failure');
      }
      append(id, version, type, data);
    };
    const result = await f.deliveries.run(f.execution.id, f.spec);
    assert.equal(result.phase, 'failed');
    assert.equal(result.outcome, null);
    assert.match(result.error!, /journal failure/);
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
    assert.ok(!f.store.events(f.task.id).some(event => event.type === 'task.completed'));
    assert.equal(f.store.lease(f.workspace.id), null);
  }
});
