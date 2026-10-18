// Guided task tests: workspace and slice preparation before implementation and checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided-tasks.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import type { RepositoryCheck } from '../src/verification/checks.js';
import { windows, preparation, git, services, fixture } from './helpers/guided-tasks.js';

test('fresh worktrees prepare before implementation and refresh prerequisites before checks', windows, async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, '.gitignore'), 'prepared/\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Ignore fixture prerequisites');
  const configured = services();
  let implementations = 0;
  const tasks = new GuidedTasks(f.store, {
    ...configured,
    implementationRunner: async options => {
      implementations++;
      assert.equal(readFileSync(join(options.cwd, 'prepared/count'), 'utf8'), '1');
      return configured.implementationRunner!(options);
    },
  });
  const task = tasks.create({
    ...f.plan,
    preparation: preparation(
      `const fs=require('node:fs');fs.mkdirSync('prepared',{recursive:true});const p='prepared/count';fs.writeFileSync(p,String(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1));console.log('prerequisites ready');`,
    ),
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const scope = await tasks.run(task.id);
  assert.equal(scope.status, 'awaiting_scope', scope.note);
  assert.equal(implementations, 0);
  const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  assert.equal(implementations, 1);
  const view = guidedTaskView(f.store, task.id),
    preparations = view.checks.filter(check => check.purpose === 'preparation');
  assert.equal(preparations.length, 2);
  assert.ok(preparations.every(check => check.phase === 'passed' && check.result?.stdout === 'prerequisites ready\n'));
  assert.equal(readFileSync(join(view.workspace!.path!, 'prepared/count'), 'utf8'), '2');
  assert.equal(
    checkpoint.snapshot!.diff.some(file => file.path.startsWith('prepared/')),
    false,
  );
  const done = await tasks.assess(task.id, 'passed', 'Inspected the implementation with restored prerequisites');
  assert.equal(done.status, 'complete', done.note);
});

test('slice preparation generates an authorized lockfile and validates the resulting artifact', windows, async t => {
  const f = fixture(t);
  for (const file of ['requirements.txt', 'deps.lock']) writeFileSync(join(f.repo, file), 'old');
  writeFileSync(join(f.repo, '.gitignore'), 'prepared/\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Dependency fixture');
  const configured = services();
  const tasks = new GuidedTasks(f.store, {
    ...configured,
    implementationRunner: async options => {
      const result = await configured.implementationRunner!(options);
      writeFileSync(join(options.cwd, 'requirements.txt'), 'new');
      return result;
    },
  });
  const task = tasks.create({
    ...f.plan,
    preparation: preparation(
      "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('requirements.txt','utf8'),fs.readFileSync('deps.lock','utf8'));fs.mkdirSync('prepared',{recursive:true});",
    ),
    slices: [
      {
        ...f.plan.slices[0],
        scope: { files: ['greeting.js', 'requirements.txt', 'deps.lock'] },
        preparation: preparation(
          "const fs=require('node:fs');fs.copyFileSync('requirements.txt','deps.lock');fs.copyFileSync('deps.lock','prepared/installed');",
        ),
        validation: preparation(
          "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('deps.lock','utf8'),'new');a.equal(fs.readFileSync('prepared/installed','utf8'),'new');",
        ),
      },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const view = guidedTaskView(f.store, task.id),
    refresh = view.checks.find(check => !!check.spec.preparation?.scope)!;
  assert.equal(refresh.phase, 'passed');
  assert.notEqual(refresh.before!.artifact, refresh.after!.artifact);
  assert.equal(checkpoint.snapshot!.artifact, refresh.after!.artifact);
  assert.equal(view.checks.at(-1)!.before!.artifact, refresh.after!.artifact);
  assert.ok(checkpoint.snapshot!.diff.some(file => file.path === 'deps.lock'));
  const done = await tasks.assess(task.id, 'passed', 'The manifest and generated lockfile agree');
  assert.equal(done.status, 'complete', done.note);
  assert.equal(git(view.workspace!.path!, 'show', 'HEAD:deps.lock'), 'new');
});

test(
  'failed initial preparation retains output and retries in the same attempt before implementation',
  windows,
  async t => {
    const f = fixture(t),
      ready = join(f.root, 'restore-available');
    const task = f.tasks.create({
      ...f.plan,
      preparation: preparation(
        `if(!require('node:fs').existsSync(${JSON.stringify(ready)})){console.error('restore unavailable');process.exit(17)}`,
      ),
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    const failed = await f.tasks.run(task.id),
      executionId = failed.executionId!;
    assert.equal(failed.status, 'blocked', failed.note);
    assert.equal(failed.stage, 'preparation');
    assert.equal(failed.owner, null);
    assert.equal(f.store.implementations(executionId).length, 0);
    assert.match(failed.note, /restore unavailable/);
    await assert.rejects(f.tasks.run(task.id), /blocked/);
    writeFileSync(ready, 'available');
    const retried = await f.tasks.retry(task.id);
    assert.equal(retried.status, 'awaiting_scope', retried.note);
    assert.equal(retried.executionId, executionId);
    assert.equal(f.store.implementations(executionId).length, 0);
    const checks = f.store.checks<RepositoryCheck>(executionId);
    assert.equal(checks[0]!.result!.exitCode, 17);
    assert.equal(checks[1]!.phase, 'passed');
  },
);

test(
  'failed slice preparation preserves allowed changes and retries without repeating implementation',
  windows,
  async t => {
    const f = fixture(t),
      restored = join(f.root, 'refresh-retried');
    writeFileSync(join(f.repo, 'deps.lock'), 'old');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'Lockfile fixture');
    const task = f.tasks.create({
      ...f.plan,
      slices: [
        {
          ...f.plan.slices[0],
          scope: { files: ['greeting.js', 'deps.lock'] },
          preparation: preparation(
            `const fs=require('node:fs');fs.writeFileSync('deps.lock','new');if(!fs.existsSync(${JSON.stringify(restored)})){fs.writeFileSync(${JSON.stringify(restored)},'ready');console.error('temporary refresh failure');process.exit(9)}`,
          ),
        },
      ],
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    await f.tasks.run(task.id);
    const failed = await f.tasks.authorize(task.id),
      executionId = failed.executionId!;
    assert.equal(failed.status, 'blocked', failed.note);
    assert.equal(failed.stage, 'refresh');
    const retried = await f.tasks.retry(task.id);
    assert.equal(retried.status, 'awaiting_assessment', retried.note);
    assert.equal(retried.executionId, executionId);
    assert.equal(f.store.implementations(executionId).length, 1);
    assert.ok(retried.snapshot!.diff.some(file => file.path === 'deps.lock'));
  },
);
