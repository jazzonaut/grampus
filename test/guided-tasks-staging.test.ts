// Guided task tests: explicit retry and automation over staged implementation files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/guided-tasks.js';
import { guidedTaskView } from '../src/guided-status.js';
import { windows, review, git, services, fixture } from './helpers/guided-tasks.js';

for (const action of ['retry', 'automate'] as const)
  test(`explicit ${action} adopts staged files after an interrupted implementation`, windows, async t => {
    const f = fixture(t),
      config = services();
    let implementations = 0;
    const runner = config.implementationRunner!;
    config.implementationRunner = async options => {
      if (implementations++) {
        assert.equal(readFileSync(join(options.cwd, 'greeting.js'), 'utf8'), "console.log('hello world');\n");
        assert.equal(git(options.cwd, 'diff', '--cached', '--name-only'), 'greeting.js');
      }
      const result = await runner(options);
      if (implementations === 1) git(options.cwd, 'add', 'greeting.js');
      return result;
    };
    config.connector = async () => ({
      turn: async () => ({
        status: 'completed',
        reply: { ...review, simplification: { outcome: 'passed', summary: 'One direct output statement.' } },
        usage: null,
        error: null,
      }),
      interrupt: async () => {},
      close: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create({ ...f.plan, workflowPolicy: { mode: action === 'retry' ? 'automatic' : 'supervised' } });
    tasks.approve(task.id, 1, task.guided!.digest);
    let stopped = await tasks.run(task.id);
    if (action === 'automate') stopped = await tasks.authorize(task.id);
    assert.equal(stopped.status, 'blocked', stopped.note);
    assert.equal(stopped.stage, 'implementation');
    assert.match(stopped.note, /staged or unstaged/);
    assert.equal(implementations, 1);
    assert.equal(f.store.checks(stopped.executionId!).length, 0);
    const done = await tasks[action](task.id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(implementations, 2);
    assert.notEqual(done.executionId, stopped.executionId);
    assert.equal(done.digest, stopped.digest);
  });

for (const mutation of ['head', 'instructions', 'outside-scope'] as const)
  test(`explicit staging retry still rejects changed ${mutation}`, windows, async t => {
    const f = fixture(t),
      config = services();
    let implementations = 0;
    const runner = config.implementationRunner!;
    config.implementationRunner = async options => {
      implementations++;
      const result = await runner(options);
      git(options.cwd, 'add', 'greeting.js');
      return result;
    };
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' } });
    tasks.approve(task.id, 1, task.guided!.digest);
    const stopped = await tasks.run(task.id);
    assert.equal(stopped.status, 'blocked', stopped.note);
    const cwd = guidedTaskView(f.store, task.id).workspace!.path!;
    if (mutation === 'head') git(cwd, 'commit', '-m', 'External commit');
    else writeFileSync(join(cwd, mutation === 'instructions' ? 'AGENTS.md' : 'outside.txt'), 'External change\n');
    await assert.rejects(tasks.retry(task.id), /Git state or repository instructions|outside the explicit/);
    assert.equal(implementations, 1);
    assert.equal(tasks.get(task.id).executionId, stopped.executionId);
    assert.equal(tasks.get(task.id).status, 'blocked');
    assert.equal(tasks.get(task.id).owner, null);
  });
