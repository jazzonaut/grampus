// Delivery tests: explicit no-change delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Delivery } from '../src/deliveries.js';
import { renderReport } from '../src/report.js';
import { windows, git, noChangeFixture } from './helpers/deliveries.js';

test(
  'explicit no-change CLI delivery preserves HEAD and index, skips commit hooks and records the outcome',
  windows,
  async t => {
    const f = await noChangeFixture(t);
    const indexPath = git(f.workspace.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const index = readFileSync(indexPath);
    writeFileSync(join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    const specFile = join(f.root, 'no-change.json');
    writeFileSync(specFile, JSON.stringify(f.spec));
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const result = JSON.parse(
      execFileSync(process.execPath, [cli, 'execution-deliver', f.execution.id, specFile, '--db', f.db], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ) as Delivery;
    assert.equal(result.phase, 'delivered', JSON.stringify(result));
    assert.equal(result.outcome, 'no_change');
    assert.equal(result.commit, null);
    assert.equal(result.request?.snapshot.head, f.snapshot.head);
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '1');
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(existsSync(join(result.receipt!.directory, 'delivery.json.message')), false);
    assert.equal(f.workflow.get(f.task.id).phase, 'complete');
    assert.equal(f.store.lease(f.workspace.id), null);
    assert.match(renderReport(f.store, f.task.id), /"outcome": "no_change"/);
  },
);

test('no-change delivery rejects dirty paths and staged mismatches without staging or committing', windows, async t => {
  const changes: ((path: string) => void)[] = [
    path => writeFileSync(join(path, 'obsolete.txt'), 'modified\n'),
    path => writeFileSync(join(path, 'untracked.txt'), 'new\n'),
    path => rmSync(join(path, 'obsolete.txt')),
    path => {
      writeFileSync(join(path, 'obsolete.txt'), 'staged\n');
      git(path, 'add', 'obsolete.txt');
      writeFileSync(join(path, 'obsolete.txt'), 'remove me\n');
    },
    path => {
      git(path, 'update-index', '--chmod=-x', 'greeting.js');
    },
  ];
  for (const change of changes) {
    const f = await noChangeFixture(t, change);
    const indexPath = git(f.workspace.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const index = readFileSync(indexPath);
    const result = await f.deliveries.run(f.execution.id, f.spec);
    assert.equal(result.phase, 'failed', JSON.stringify(result));
    assert.equal(result.outcome, null);
    assert.equal(result.commit, null);
    assert.equal(result.result?.exitConfirmed, true);
    assert.notEqual(result.result?.exitCode, 0);
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
    assert.equal(f.store.lease(f.workspace.id), null);
  }
});

test(
  'no-change requires every gate and explicit mode; commit mode never infers success from an empty diff',
  windows,
  async t => {
    const f = await noChangeFixture(t);
    await assert.rejects(
      f.deliveries.run(f.execution.id, { ...f.spec, mode: 'automatic' as 'commit' }),
      /optional mode/,
    );
    const commit = await f.deliveries.run(f.execution.id, { ...f.spec, mode: 'commit' });
    assert.equal(commit.phase, 'failed');
    assert.equal(commit.outcome, null);
    assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '1');
    f.workflow.addDecision(f.task.id, 'Pending fixture decision');
    await assert.rejects(f.deliveries.run(f.execution.id, f.spec), /Provisional decisions/);
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_decision');
  },
);
