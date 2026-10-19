// Live monitoring reads real Git changes without updating the journal or verification evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readLiveChanges } from '../src/server/live-changes.js';
import { fixture, git } from './helpers/guided-tasks.js';
import { monitoringLimits } from '../src/config/limits.js';

test('live changes include unstaged, staged, new and deleted files against the pinned task base', async t => {
  const f = fixture(t);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  const revision = f.store.revision();
  writeFileSync(join(f.repo, 'greeting.js'), "console.log('in progress');\n");
  writeFileSync(join(f.repo, 'new file.txt'), 'new content\n');
  unlinkSync(join(f.repo, 'AGENTS.md'));
  git(f.repo, 'add', 'greeting.js');
  const live = await readLiveChanges(f.repo, base, 'greeting.js');
  assert.deepEqual(live.paths, ['AGENTS.md', 'greeting.js', 'new file.txt']);
  assert.match(live.selected!.patch, /-console.log\('hello'\)/);
  assert.match(live.selected!.patch, /\+console.log\('in progress'\)/);
  const created = await readLiveChanges(f.repo, base, 'new file.txt');
  assert.match(created.selected!.patch, /\+new content/);
  const deleted = await readLiveChanges(f.repo, base, 'AGENTS.md');
  assert.match(deleted.selected!.patch, /-Use one direct output statement/);
  await assert.rejects(readLiveChanges(f.repo, base, '../outside.txt'), /changed path/);
  assert.equal(f.store.revision(), revision);
});

test('reverted selections clear and large patches are explicitly truncated', async t => {
  const f = fixture(t);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'greeting.js'), 'x'.repeat(monitoringLimits.patchBytes * 2));
  const large = await readLiveChanges(f.repo, base, 'greeting.js');
  assert.equal(large.selected!.truncated, true);
  git(f.repo, 'restore', 'greeting.js');
  const reverted = await readLiveChanges(f.repo, base, 'greeting.js');
  assert.deepEqual(reverted.paths, []);
  assert.equal(reverted.selected, null);
});

test('live diffs do not execute external diff drivers or text conversion', async t => {
  const f = fixture(t);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'config', 'diff.external', 'this-command-must-never-run');
  git(f.repo, 'config', 'diff.monitor.textconv', 'this-command-must-never-run');
  writeFileSync(join(f.repo, '.gitattributes'), '*.js diff=monitor\n');
  writeFileSync(join(f.repo, 'greeting.js'), 'changed\n');
  assert.match((await readLiveChanges(f.repo, base, 'greeting.js')).selected!.patch, /\+changed/);
});

test('live changes bypass required clean and process filters as well as diff drivers', async t => {
  const f = fixture(t);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'config', 'filter.monitor.clean', 'this-command-must-never-run');
  git(f.repo, 'config', 'filter.monitor.process', 'this-command-must-never-run');
  git(f.repo, 'config', 'filter.monitor.required', 'true');
  writeFileSync(join(f.repo, '.gitattributes'), '*.js filter=monitor\n');
  writeFileSync(join(f.repo, 'greeting.js'), 'changed\n');
  assert.match((await readLiveChanges(f.repo, base, 'greeting.js')).selected!.patch, /\+changed/);
});
