// Parallel guided tasks: the bounded runner pool across controller processes on one source repository,
// its refusals in the controller, the dashboard and the CLI, and how a slot is released on settlement and
// on recovery of a crashed owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { RunnerPoolFullError, runnerPool } from '../src/orchestration/guided/runner-pool.js';
import { defaultSettings, useSettings } from '../src/config/settings.js';
import { startUi } from '../src/server/ui-server.js';
import type { ErrorV1, OverviewV1 } from '../src/server/api-types.js';
import { windows, cli, git, lens, message, review, services, fixture, crashProgram } from './helpers/guided-tasks.js';

/** Longest a child controller waits at the barrier, and the test waits for both children to reach it. */
const barrierMs = 30_000;
/** How often the test and the children look for barrier files. */
const pollMs = 50;

/**
 * Writes a program that runs one automatic task in its own process with offline providers, as a dashboard
 * worker or `task-run` would. Its implementer marks `started-<id>` and waits for `release`, so the test
 * can hold two tasks inside their runners at the same time. Exits 0 only when the task completed.
 */
function controllerProgram(f: ReturnType<typeof fixture>): string {
  const file = join(f.root, 'run-task.mjs');
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  const reply = { ...review, lenses: [lens('pass', 'One direct output statement.')] };
  writeFileSync(
    file,
    `
    import { existsSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { setTimeout as sleep } from 'node:timers/promises';
    import { Store } from ${url('persistence/store')}; import { GuidedTasks } from ${url('orchestration/guided/controller')}; import { runCheckProcess } from ${url('process/check-process')};
    const [db, id, root] = process.argv.slice(2);
    const message = ${JSON.stringify(message)}, review = ${JSON.stringify(review)};
    const offline = (${services.toString()})();
    const store = new Store(db);
    const tasks = new GuidedTasks(store, {
      implementationRunner: async options => {
        writeFileSync(join(root, 'started-' + id), '');
        for (const deadline = Date.now() + ${barrierMs}; !existsSync(join(root, 'release')); await sleep(${pollMs}))
          if (Date.now() > deadline) throw new Error('The test never released the barrier');
        return offline.implementationRunner(options);
      },
      connector: async () => ({
        turn: async () => ({ status: 'completed', reply: ${JSON.stringify(reply)}, usage: null, error: null }),
        interrupt: async () => {},
        close: async () => {},
      }),
    });
    const state = await tasks.run(id);
    store.close();
    if (state.status !== 'complete') { console.error(state.status + ': ' + state.note); process.exit(3); }
  `,
  );
  return file;
}

/** The exit code and stderr of a child process once it has exited. */
function exited(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  return new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
}

test(
  'two automatic tasks on one repository run at once and both deliver while a third claim is refused',
  windows,
  async t => {
    const f = fixture(t),
      base = git(f.repo, 'rev-parse', 'HEAD');
    const automatic = (name: string) =>
      f.tasks.create({
        ...f.plan,
        workflowPolicy: { mode: 'automatic' },
        workspace: { ...f.plan.workspace, path: join(f.root, `workspace-${name}`) },
        slices: [{ ...f.plan.slices[0], message: `Implement greeting ${name}` }],
      });
    const [first, second] = ['a', 'b'].map(name => {
      const task = automatic(name);
      f.tasks.approve(task.id, 1, task.guided!.digest);
      return task.id;
    }) as [string, string];
    const third = f.create();
    const program = controllerProgram(f);
    const children = [first, second].map(id =>
      exited(
        spawn(process.execPath, [program, f.store.path, id, f.root], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        }),
      ),
    );
    const started = (id: string) => existsSync(join(f.root, `started-${id}`));
    for (const deadline = Date.now() + barrierMs; !(started(first) && started(second)); await sleep(pollMs))
      assert.ok(Date.now() < deadline, 'both tasks reach implementation while the other is still running');

    // Both controllers own a runner at once; a third claim is refused everywhere and changes nothing.
    assert.deepEqual(runnerPool(f.store), { active: 2, limit: 2, owners: [first, second] });
    await assert.rejects(f.tasks.run(third), RunnerPoolFullError);
    assert.equal(f.tasks.get(third).status, 'ready');
    assert.equal(f.tasks.get(third).owner, null);
    const refusedCli = spawnSync(process.execPath, [cli, '--db', f.store.path, 'task-run', third], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GRAMPUS_HOME: join(f.root, 'home') },
    });
    assert.equal(refusedCli.status, 1, refusedCli.stderr);
    assert.match(
      refusedCli.stderr,
      new RegExp(`2 of 2 guided tasks are already running .*Run grampus task-run ${third} again once a slot is free`),
    );
    const ui = await startUi({ db: f.store.path, port: 0 });
    try {
      const url = new URL(ui.url),
        headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
      const post = (path: string, body: unknown) =>
        fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
      const decision = (id: string) => {
        const view = guidedTaskView(f.store, id);
        return guidedDecisionKey(view.state, view.questionKey);
      };
      const home = (await (await fetch(`${url.origin}/api/v1/overview`, { headers })).json()) as OverviewV1;
      assert.deepEqual(home.pool, { running: 2, limit: 2, owners: [first, second] });
      const refused = await post(`/api/tasks/${third}/run`, { expected: decision(third) });
      assert.equal(refused.status, 409);
      const { error } = (await refused.json()) as ErrorV1;
      assert.equal(error.code, 'pool_full');
      assert.match(error.message, /2 of 2 guided tasks are already running/);
      // Approval of an automatic plan stands, but does not start it while the pool is full.
      const draft = automatic('d');
      const approved = await post(`/api/tasks/${draft.id}/approve`, {
        expected: decision(draft.id),
        version: 1,
        digest: draft.guided!.digest,
      });
      assert.equal(approved.status, 200);
      assert.deepEqual(await approved.json(), { ok: true, started: false });
      assert.equal(f.tasks.get(draft.id).status, 'ready');
    } finally {
      await ui.close();
    }

    writeFileSync(join(f.root, 'release'), '');
    for (const result of await Promise.all(children)) assert.equal(result.code, 0, result.stderr);
    // Each task delivered its own verified commit on its own branch of the shared repository.
    for (const [id, name] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      const state = f.tasks.get(id),
        branch = `grampus/${id}`;
      assert.equal(state.status, 'complete', state.note);
      assert.equal(state.owner, null);
      assert.equal(guidedTaskView(f.store, id).deliveries[0]!.outcome, 'committed');
      assert.equal(git(f.repo, 'rev-parse', `${branch}^`), base);
      assert.equal(git(f.repo, 'show', `${branch}:greeting.js`), "console.log('hello world');");
      assert.match(git(f.repo, 'log', '-1', '--format=%B', branch), new RegExp(`^Implement greeting ${name}`));
      assert.equal(git(join(f.root, `workspace-${name}`), 'status', '--porcelain'), '');
    }
    assert.equal(git(f.repo, 'rev-parse', 'main'), base);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');

    // Settled tasks released their slots, so the refused task now starts.
    assert.equal(runnerPool(f.store).active, 0);
    const prepared = await f.tasks.run(third);
    assert.equal(prepared.status, 'awaiting_scope', prepared.note);
  },
);

test('a crashed owner keeps its slot until recovery, which a full pool never blocks', windows, async t => {
  useSettings({ ...defaultSettings(), maxConcurrentTasks: 1 });
  t.after(() => useSettings(defaultSettings()));
  const f = fixture(t),
    crashed = f.create();
  const waiting = f.tasks.create({ ...f.plan, workspace: { ...f.plan.workspace, path: join(f.root, 'other') } });
  f.tasks.approve(waiting.id, 1, waiting.guided!.digest);
  await f.tasks.run(crashed);
  assert.equal(f.tasks.get(crashed).owner, null, 'a settled stop releases the slot');
  crashProgram(f, 'authorize', 'validation', crashed);
  assert.ok(f.tasks.get(crashed).owner);
  assert.deepEqual(runnerPool(f.store), { active: 1, limit: 1, owners: [crashed] });
  await assert.rejects(f.tasks.run(waiting.id), /1 of 1 guided tasks are already running/);
  const recovered = await f.tasks.recover(crashed);
  assert.equal(recovered.status, 'ready', recovered.note);
  assert.equal(recovered.owner, null);
  assert.equal(runnerPool(f.store).active, 0);
  const prepared = await f.tasks.run(waiting.id);
  assert.equal(prepared.status, 'awaiting_scope', prepared.note);
  assert.equal(prepared.owner, null);
});
