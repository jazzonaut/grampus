// Native execution may adapt project files while final snapshots still fence controller Git delivery.
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareEditing, verifyEditingScope } from '../src/execution/edit-policy.js';
import { snapshotRepository } from '../src/repository/artifacts.js';
import { fixture, git } from './helpers/guided-tasks.js';

test('workspace execution permits new directories, renamed files and binary assets without file grants', async t => {
  const f = fixture(t);
  const snapshot = await snapshotRepository(f.repo, 'HEAD');
  const context = {
    cwd: f.repo,
    snapshot,
    policy: {
      workspace: true as const,
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
      files: [],
    },
  };
  prepareEditing(context);
  mkdirSync(join(f.repo, 'new-helper'));
  renameSync(join(f.repo, 'greeting.js'), join(f.repo, 'new-helper', 'greeting.js'));
  writeFileSync(join(f.repo, 'new-helper', 'asset.bin'), Buffer.from([0, 255, 0]));
  const after = await snapshotRepository(f.repo, 'HEAD');
  assert.notEqual(after.artifact, snapshot.artifact);
  assert.doesNotThrow(() => verifyEditingScope(context, after));
  git(f.repo, 'add', '.');
  const staged = await snapshotRepository(f.repo, 'HEAD');
  assert.throws(() => verifyEditingScope(context, staged), /staged or unstaged/);
});
