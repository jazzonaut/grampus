import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { GuidedTasks, guidedDecisionKey, type GuidedServices } from '../src/guided-tasks.js';
import { guidedTaskView, renderGuidedTask } from '../src/guided-status.js';
import { Workflow } from '../src/workflow.js';
import { runCheckProcess } from '../src/check-process.js';
import type { Reply } from '../src/agents/types.js';
import type { ImplementationRun } from '../src/implementations.js';
import { renderReport } from '../src/report.js';
import { Kickoffs } from '../src/kickoff.js';
import { repositoryTools } from '../src/repository-tools.js';
import { Checks, type RepositoryCheck } from '../src/checks.js';
import { Sessions } from '../src/sessions.js';

const windows = { skip: process.platform !== 'win32' };
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const message: Reply = { kind: 'message', text: 'Offline fixture implementation', questions: [], findings: [] };
const review: Reply = { kind: 'review', text: 'Offline fixture review', questions: [], findings: [] };

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

test('automatic work repairs a failed check with complete evidence and resumes its implementer', windows, async t => {
  const f = fixture(t);
  let implementations = 0;
  const config = services();
  config.implementationRunner = options => {
    const request = JSON.parse(readFileSync(options.args[1]!, 'utf8'));
    const run = f.store.implementation<ImplementationRun>(request.id);
    const execution = f.store.execution<any>(run.executionId),
      sessions = new Sessions(f.store);
    const session = sessions.get(execution.sessionId);
    if (implementations++) {
      assert.equal(session.providerSessionId, 'offline-implementation');
      assert.match(request.prompt, /Actual assertion at the end/);
      assert.match(request.prompt, /grampus_read_check/);
      assert.ok(request.prompt.length < 20000);
    }
    sessions.event(session.id, run.id, {
      type: 'session.connected',
      data: { providerSessionId: 'offline-implementation', model: 'fixture' },
    });
    return services(implementations === 1 ? "console.log('wrong');\n" : "console.log('hello world');\n")
      .implementationRunner!(options);
  };
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: {
        ...review,
        simplification: {
          outcome: 'passed',
          summary: 'One output statement; no duplication or unnecessary abstractions.',
        },
      },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    slice = f.plan.slices[0]!;
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [
      {
        ...slice,
        validation: {
          file: 'node',
          args: [
            '-e',
            "if(require('node:fs').readFileSync('greeting.js','utf8').includes('wrong')){console.error('noise '.repeat(4000));console.error('\\u001b[31mAssertionError: Actual assertion at the end\\u001b[0m');process.exitCode=1}",
          ],
          timeoutMs: 15000,
        },
      },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(implementations, 2);
  const events = f.store.events(task.id);
  assert.equal(events.filter(event => event.type === 'guided.validation_repair_requested').length, 1);
  assert.ok(
    !events.some(
      event =>
        (event.data as any)?.status === 'awaiting_scope' || (event.data as any)?.status === 'awaiting_assessment',
    ),
  );
  assert.equal(
    f.store.get<any>(task.id).evidence.find((e: any) => e.kind === 'simplification' && e.outcome === 'passed').source,
    'agent',
  );
});

test('automatic validation stops spending tokens when a repair leaves content unchanged', windows, async t => {
  const f = fixture(t);
  let implementations = 0;
  const config = services("console.log('wrong');\n");
  const runner = config.implementationRunner!;
  config.implementationRunner = options => {
    implementations++;
    return runner(options);
  };
  const tasks = new GuidedTasks(f.store, config),
    task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic', repairRounds: 3 } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const stopped = await tasks.run(task.id);
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.note, /no.*progress|unchanged/i);
  assert.equal(implementations, 2);
  assert.equal(f.store.deliveries(stopped.executionId!).length, 0);
});

test(
  'automatic acceptance repair invalidates earlier evidence and resumes its independent reviewer',
  windows,
  async t => {
    const f = fixture(t);
    let implementations = 0,
      reviews = 0;
    const config = services();
    config.implementationRunner = options =>
      services(++implementations === 1 ? "console.log('wrong');\n" : "console.log('hello world');\n")
        .implementationRunner!(options);
    config.connector = async (_provider, options) => ({
      turn: async () => {
        if (reviews++) assert.equal(options.providerSessionId, 'same-independent-reviewer');
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: 'same-independent-reviewer', model: 'fixture' },
        });
        return {
          status: 'completed',
          reply: {
            ...review,
            simplification: { outcome: 'passed', summary: 'Inspected the current single output statement.' },
          },
          usage: null,
          error: null,
        };
      },
      close: async () => {},
      interrupt: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create({
        ...f.plan,
        workflowPolicy: { mode: 'automatic' },
        slices: [{ ...f.plan.slices[0], validation: { file: 'node', args: ['--check', 'greeting.js'] } }],
      });
    tasks.approve(task.id, 1, task.guided!.digest);
    const done = await tasks.run(task.id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(implementations, 2);
    assert.equal(reviews, 2);
    assert.ok(f.store.events(task.id).some(event => event.type === 'guided.acceptance_repair_requested'));
    assert.ok(
      f.store.get<any>(task.id).evidence.every((e: any) => e.attemptId === f.store.get<any>(task.id).attempt.id),
    );
  },
);

test(
  'legacy plans can explicitly enable automatic continuation without changing their approved digest',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    config.connector = async () => ({
      turn: async () => ({
        status: 'completed',
        reply: {
          ...review,
          simplification: { outcome: 'passed', summary: 'The direct output statement needs no further abstraction.' },
        },
        usage: null,
        error: null,
      }),
      close: async () => {},
      interrupt: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create(f.plan);
    // A saved plan predating workflow policy must keep its exact approval digest.
    delete task.guided!.plan.workflowPolicy;
    task.guided!.digest = (await import('../src/guided-plan.js')).guidedPlanDigest(task.guided!.plan);
    f.store.save(task.id, task);
    tasks.approve(task.id, 1, task.guided!.digest);
    const scope = await tasks.run(task.id);
    assert.equal(scope.status, 'awaiting_scope');
    const done = await tasks.automate(task.id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(done.digest, scope.digest);
    assert.equal(done.automationEnabled, true);
  },
);

test('an independent failed simplification assessment triggers repair rather than a manual form', windows, async t => {
  const f = fixture(t);
  let edits = 0,
    reviews = 0;
  const config = services();
  config.implementationRunner = options =>
    services(++edits === 1 ? "// needless explanation\nconsole.log('hello world');\n" : "console.log('hello world');\n")
      .implementationRunner!(options);
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: {
        ...review,
        simplification:
          ++reviews === 1
            ? { outcome: 'failed', summary: 'Remove the comment that repeats the output statement.' }
            : { outcome: 'passed', summary: 'The direct output statement now stands on its own.' },
      },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(edits, 2);
  assert.equal(reviews, 2);
});

function preparation(code: string) {
  return { name: 'Restore repository prerequisites', file: 'node', args: ['-e', code], timeoutMs: 15000 };
}

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

for (const stage of ['initial', 'slice'] as const)
  test(`${stage} preparation cannot change unauthorized inputs or be used as validation`, windows, async t => {
    const f = fixture(t),
      command = preparation("require('node:fs').writeFileSync('AGENTS.md','unauthorized');");
    const task = f.tasks.create({
      ...f.plan,
      ...(stage === 'initial' ? { preparation: command } : {}),
      slices: [{ ...f.plan.slices[0], ...(stage === 'slice' ? { preparation: command } : {}) }],
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    let result = await f.tasks.run(task.id);
    if (stage === 'slice') result = await f.tasks.authorize(task.id);
    assert.equal(result.status, 'blocked', result.note);
    assert.match(result.note, /changed repository inputs|Git state or repository instructions/);
    const checks = f.store.checks<RepositoryCheck>(result.executionId!);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.purpose, 'preparation');
    await assert.rejects(f.tasks.retry(task.id), /changed repository inputs|Git state or repository instructions/);
    assert.equal(f.store.checks(result.executionId!).length, 1);
    assert.equal(f.store.deliveries(result.executionId!).length, 0);
  });

test('a passing preparation cannot replace validation evidence', windows, async t => {
  const f = fixture(t),
    task = f.tasks.create({ ...f.plan, preparation: preparation("console.log('ready')") });
  f.tasks.approve(task.id, 1, task.guided!.digest);
  const scope = await f.tasks.run(task.id);
  const check = f.store.checks<RepositoryCheck>(scope.executionId!)[0]!;
  await assert.rejects(new Checks(f.store).finish(scope.executionId!, check.id), /preparation is not validation/);
  assert.equal(
    new Workflow(f.store)
      .get(task.id)
      .evidence.some(evidence => evidence.kind === 'validation' && evidence.outcome === 'passed'),
    false,
  );
});

test('recovery adopts a completed preparation without replaying it or starting implementation', windows, async t => {
  const f = fixture(t),
    marker = join(f.root, 'restore-count');
  const task = f.tasks.create({
    ...f.plan,
    preparation: preparation(
      `const fs=require('node:fs'),p=${JSON.stringify(marker)};fs.writeFileSync(p,String(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1));`,
    ),
  });
  f.tasks.approve(task.id, 1, task.guided!.digest);
  const file = join(f.root, 'crash-preparation.mjs');
  writeFileSync(
    file,
    `import {Store} from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    import {GuidedTasks} from ${JSON.stringify(new URL('../src/guided-tasks.js', import.meta.url).href)};
    const store=new Store(${JSON.stringify(f.store.path)}),append=store.append.bind(store);
    store.append=(id,version,type,data)=>{if(type==='guided.step_finished'&&data.stage==='scope')process.exit(29);append(id,version,type,data)};
    await new GuidedTasks(store).run(${JSON.stringify(task.id)});throw new Error('Expected controller exit');`,
  );
  assert.throws(
    () => execFileSync(process.execPath, [file], { windowsHide: true, stdio: 'pipe' }),
    (error: unknown) => (error as { status: number }).status === 29,
  );
  assert.equal(f.tasks.get(task.id).pending!.stage, 'preparation');
  const recovered = await f.tasks.recover(task.id);
  assert.equal(recovered.status, 'ready', recovered.note);
  assert.equal(recovered.stage, 'scope');
  assert.equal(readFileSync(marker, 'utf8'), '1');
  const scope = await f.tasks.run(task.id);
  assert.equal(scope.status, 'awaiting_scope', scope.note);
  assert.equal(readFileSync(marker, 'utf8'), '1');
  assert.equal(f.store.implementations(scope.executionId!).length, 0);
});

test('interrupted preparation remains retryable without starting a new attempt', windows, async t => {
  const f = fixture(t);
  let first = true;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    preparationRunner: async options => {
      if (first) {
        first = false;
        return {
          reason: 'interrupted',
          exitCode: null,
          exitConfirmed: true,
          stdout: '',
          stderr: 'Stopped during restore',
          outputTruncated: false,
        };
      }
      return runCheckProcess(options);
    },
  });
  const task = tasks.create({ ...f.plan, preparation: preparation("console.log('restored')") });
  tasks.approve(task.id, 1, task.guided!.digest);
  const interrupted = await tasks.run(task.id);
  assert.equal(interrupted.status, 'blocked', interrupted.note);
  assert.equal(interrupted.owner, null);
  assert.equal(f.store.checks<RepositoryCheck>(interrupted.executionId!)[0]!.phase, 'interrupted');
  const retried = await tasks.retry(task.id);
  assert.equal(retried.status, 'awaiting_scope', retried.note);
  assert.equal(retried.executionId, interrupted.executionId);
});

test(
  'unconfirmed preparation shutdown retains ownership and cannot retry or start implementation',
  windows,
  async t => {
    const f = fixture(t);
    let dispatches = 0;
    const tasks = new GuidedTasks(f.store, {
      ...services(),
      preparationRunner: async () => {
        dispatches++;
        return {
          reason: 'supervisor_failed',
          exitCode: null,
          exitConfirmed: false,
          stdout: '',
          stderr: 'Shutdown unconfirmed',
          outputTruncated: false,
        };
      },
    });
    const task = tasks.create({ ...f.plan, preparation: preparation("console.log('restore')") });
    tasks.approve(task.id, 1, task.guided!.digest);
    const uncertain = await tasks.run(task.id);
    assert.equal(uncertain.status, 'recovery_required', uncertain.note);
    assert.ok(uncertain.owner);
    assert.ok(uncertain.pending);
    assert.ok(f.store.lease(uncertain.workspaceId!));
    assert.equal(f.store.implementations(uncertain.executionId!).length, 0);
    await assert.rejects(tasks.retry(task.id), /recover uncertain/);
    await assert.rejects(tasks.run(task.id), /recovery_required/);
    await assert.rejects(tasks.recover(task.id), /still alive|unverifiable/);
    assert.equal(dispatches, 1);
  },
);

test(
  'no-change slices can prepare prerequisites while preserving every gate and the original commit',
  windows,
  async t => {
    const f = fixture(t),
      base = git(f.repo, 'rev-parse', 'HEAD');
    const task = f.tasks.create({
      ...f.plan,
      brief: {
        title: 'Verify existing greeting',
        outcome: 'Confirm hello with a newline',
        criteria: ['Print hello with a newline'],
        plan: 'Prepare and independently verify without editing',
      },
      preparation: preparation("console.log('prerequisites ready')"),
      slices: [
        {
          scope: { files: [] },
          mode: 'no_change',
          validation: preparation(
            "require('node:assert/strict').equal(require('node:fs').readFileSync('greeting.js','utf8'),\"console.log('hello');\\n\")",
          ),
          acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello\n' },
          message: 'Verify existing greeting',
        },
      ],
    });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    await f.tasks.run(task.id);
    const checkpoint = await f.tasks.authorize(task.id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(f.store.implementations(checkpoint.executionId!).length, 0);
    const done = await f.tasks.assess(task.id, 'passed', 'The existing direct output needs no edits');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(guidedTaskView(f.store, task.id).deliveries[0]!.outcome, 'no_change');
    assert.equal(git(guidedTaskView(f.store, task.id).workspace!.path!, 'rev-parse', 'HEAD'), base);
  },
);
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}
function services(source = "console.log('hello world');\n", reply: Reply = message): GuidedServices {
  return {
    implementationRunner: options =>
      runCheckProcess({
        ...options,
        args: [
          '-e',
          `
      const fs = require('node:fs'); fs.writeFileSync('greeting.js', ${JSON.stringify(source)});
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},
        result:{status:'completed',reply:${JSON.stringify(reply)},usage:null,error:null}}));
    `,
        ],
      }),
    connector: async (_, options) => ({
      turn: async () => {
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: 'offline-guided-review', model: 'fixture' },
        });
        return { status: 'completed', reply: review, usage: null, error: null };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  };
}
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-guided-')),
    repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'AGENTS.md'), 'Use one direct output statement.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Fixture baseline');
  const store = new Store(join(root, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const plan = {
    workflowPolicy: { mode: 'supervised' },
    brief: {
      title: 'Guided greeting',
      outcome: 'Print hello world',
      criteria: ['Print hello world with a newline'],
      plan: 'Edit, validate, simplify, review, verify and deliver locally',
    },
    workspace: { repo, path: join(root, 'workspace'), base: 'HEAD' },
    implementation: { provider: 'codex' },
    slices: [
      {
        scope: { files: ['greeting.js'] },
        validation: {
          file: 'node',
          args: [
            '-e',
            "const a=require('node:assert/strict');const {execFileSync}=require('node:child_process');a.equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n');console.log('validated');",
          ],
          timeoutMs: 15000,
        },
        acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello world\n', timeoutMs: 15000 },
        message: 'Implement guided greeting',
      },
    ],
  };
  const tasks = new GuidedTasks(store, services());
  const create = () => {
    const task = tasks.create(plan);
    tasks.approve(task.id, 1, task.guided!.digest);
    return task.id;
  };
  return { root, repo, store, plan, tasks, create };
}

test('legacy guided agent deadlines no longer stop implementation or review', windows, async t => {
  const f = fixture(t);
  const plan = {
    ...f.plan,
    implementation: { provider: 'codex', timeoutMs: 100 },
    review: { provider: 'claude', timeoutMs: 100 },
  };
  const fake = services();
  const tasks = new GuidedTasks(f.store, {
    ...fake,
    implementationRunner: async options => {
      assert.equal(options.timeoutMs, 0);
      return fake.implementationRunner!(options);
    },
    connector: async () => ({
      turn: async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { status: 'completed', reply: review, usage: null, error: null };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  });
  const task = tasks.create(plan),
    digest = task.guided!.digest;
  tasks.approve(task.id, 1, digest);
  await tasks.run(task.id);
  await tasks.authorize(task.id);
  assert.equal(tasks.get(task.id).status, 'awaiting_assessment');
  await tasks.assess(task.id, 'passed', 'Direct output statement, no unnecessary abstraction');
  assert.equal(tasks.get(task.id).status, 'complete', tasks.get(task.id).note);
  assert.equal(tasks.get(task.id).digest, digest);
});

test(
  'guided plan approval binds the complete recipe and CLI setup reaches a scope checkpoint without inference',
  windows,
  async t => {
    const f = fixture(t),
      file = join(f.root, 'plan.json');
    writeFileSync(file, JSON.stringify(f.plan));
    const invoke = (...args: string[]) =>
      execFileSync(process.execPath, [cli, '--db', f.store.path, '--json', ...args], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe',
      });
    const created = JSON.parse(invoke('task-new', file)) as ReturnType<typeof guidedTaskView>;
    assert.equal(created.state.status, 'draft');
    assert.equal(created.state.plan.workspace.base, git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal(created.state.plan.slices[0]!.validation.file, process.execPath);
    assert.equal(f.store.workspaces().length, 0);
    assert.equal(f.store.sessions().length, 0);
    assert.throws(() => invoke('task-approve', created.task.id, '1', 'wrong'));
    await assert.rejects(f.tasks.run(created.task.id), /Approve/);
    invoke('task-approve', created.task.id, '1', created.state.digest);
    const prepared = JSON.parse(invoke('task-run', created.task.id)) as ReturnType<typeof guidedTaskView>;
    assert.equal(prepared.state.status, 'awaiting_scope');
    assert.equal(prepared.implementations.length, 0);
    assert.equal(prepared.workspace!.baseCommit, created.state.plan.workspace.base);
    assert.match(renderGuidedTask(f.store, created.task.id, true), /Use one direct output statement/);
    assert.match(prepared.next, /task-authorize/);
    assert.equal(prepared.state.owner, null);
    await assert.rejects(f.tasks.run(created.task.id), /awaiting_scope/);
  },
);

test('guided task connects real gates and a verified local commit across controller restarts', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  const second = new Store(f.store.path);
  try {
    const tasks = new GuidedTasks(second, services());
    const checkpoint = await tasks.authorize(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(new Workflow(second).get(id).evidence.filter(item => item.outcome === 'passed').length, 1);
    assert.equal(second.implementations<ImplementationRun>(checkpoint.executionId!).length, 1);
    assert.match(renderGuidedTask(second, id, true), /validated/);
    assert.throws(() => tasks.approve(id, 1, checkpoint.digest), /draft/);
    const done = await tasks.assess(
      id,
      'passed',
      'One direct statement follows the repository rule; no unnecessary abstractions.',
    );
    assert.equal(done.status, 'complete', done.note);
    assert.equal(done.owner, null);
    const view = guidedTaskView(second, id);
    assert.equal(view.task.phase, 'complete');
    assert.equal(view.deliveries.length, 1);
    assert.equal(view.deliveries[0]!.phase, 'delivered');
    assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD^'), done.plan.workspace.base);
    assert.equal(git(view.workspace!.path!, 'status', '--porcelain'), '');
    assert.match(renderReport(second, id), /guided.scope_authorized/);
    const turns = second.sessions().length;
    await assert.rejects(tasks.run(id), /complete/);
    await assert.rejects(tasks.assess(id, 'passed', 'repeat'), /No simplification/);
    assert.equal(second.sessions().length, turns);
  } finally {
    second.close();
  }
});

test(
  'revising an approved recipe preserves partial edits, rejects stale decisions and requires every fresh gate',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    const submitted = await f.tasks.authorize(id),
      oldKey = guidedDecisionKey(submitted);
    const before = readFileSync(join(f.plan.workspace.path, 'greeting.js'), 'utf8');
    const input = structuredClone(submitted.plan);
    input.brief.title = 'Revised greeting';
    input.slices[0]!.message = 'Deliver revised greeting';
    const revised = await new GuidedTasks(f.store, { expectedState: oldKey }).revise(id, input);
    assert.equal(revised.version, 2);
    assert.equal(revised.status, 'draft');
    assert.equal(revised.approvedDigest, null);
    assert.equal(revised.workspaceId, submitted.workspaceId);
    assert.equal(readFileSync(join(f.plan.workspace.path, 'greeting.js'), 'utf8'), before);
    assert.equal(new Workflow(f.store).get(id).evidence.length, 0);
    assert.equal(
      f.store.execution<import('../src/execution-state.js').Execution>(submitted.executionId!).phase,
      'closed',
    );
    assert.equal(f.store.workspace<import('../src/workspaces.js').Workspace>(revised.workspaceId!).version, 2);
    assert.throws(
      () => new GuidedTasks(f.store, { expectedState: oldKey }).approve(id, 2, revised.digest),
      /changed since/,
    );
    assert.throws(() => f.tasks.approve(id, 1, submitted.digest), /current draft/);
    await assert.rejects(f.tasks.authorize(id), /Approve/);
    f.tasks.approve(id, 2, revised.digest);
    const ready = await f.tasks.run(id);
    assert.equal(ready.status, 'awaiting_scope', ready.note);
    assert.notEqual(ready.executionId, submitted.executionId);
    const assessed = await f.tasks.authorize(id);
    assert.equal(assessed.status, 'awaiting_assessment', assessed.note);
    const done = await f.tasks.assess(id, 'passed', 'Reinspected the revised task and its single output statement');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(f.store.workspaces().length, 1);
    assert.match(renderReport(f.store, id), /guided.revised/);
  },
);

test(
  'large tracked text reaches verified delivery while ignored output stays outside its artifact',
  windows,
  async t => {
    const f = fixture(t),
      padding = '// padding for a large ordinary source file\n'.repeat(10000);
    writeFileSync(join(f.repo, 'greeting.js'), "console.log('hello');\n" + padding);
    writeFileSync(join(f.repo, '.gitignore'), 'generated/\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'Large source baseline');
    const config = services();
    config.implementationRunner = options =>
      runCheckProcess({
        ...options,
        args: [
          '-e',
          `
    const fs = require('node:fs');
    fs.writeFileSync('greeting.js', fs.readFileSync('greeting.js', 'utf8').replace("console.log('hello')", "console.log('hello world')"));
    fs.mkdirSync('generated', {recursive:true}); fs.writeFileSync('generated/build.bin', Buffer.alloc(2*1024*1024));
    fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},
      result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));
  `,
        ],
      });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create(f.plan);
    tasks.approve(task.id, task.version, task.guided!.digest);
    const scope = await tasks.run(task.id);
    assert.equal(scope.status, 'awaiting_scope', scope.note);
    const edited = await tasks.authorize(task.id);
    assert.equal(edited.status, 'awaiting_assessment', edited.note);
    const done = await tasks.assess(
      task.id,
      'passed',
      'One direct output statement changed; the retained comment text is unchanged.',
    );
    assert.equal(done.status, 'complete', done.note);
    const workspace = guidedTaskView(f.store, task.id).workspace!.path!;
    assert.equal(readFileSync(join(workspace, 'greeting.js'), 'utf8'), "console.log('hello world');\n" + padding);
    assert.equal(git(workspace, 'show', 'HEAD:greeting.js'), ("console.log('hello world');\n" + padding).trim());
    assert.equal(git(workspace, 'status', '--porcelain'), '');
  },
);

test(
  'revisions reject changed workspace identity and approval cannot run against changed retained bytes',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    const checkpoint = await f.tasks.run(id);
    const wrong = structuredClone(checkpoint.plan);
    wrong.workspace.path = join(f.root, 'other');
    await assert.rejects(f.tasks.revise(id, wrong), /preserve the repository/);
    assert.equal(f.tasks.get(id).version, 1);
    assert.equal(f.tasks.get(id).owner, null);
    const revised = await f.tasks.revise(id, checkpoint.plan);
    f.tasks.approve(id, revised.version, revised.digest);
    writeFileSync(join(f.plan.workspace.path, 'greeting.js'), "console.log('unapproved edit');\n");
    const blocked = await f.tasks.run(id);
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.note, /changed since revised plan/);
    assert.equal(f.store.executions().length, 1);
  },
);

test(
  'approved repair budget prepares a fresh authorization, retains findings and never infers simplification',
  windows,
  async t => {
    const f = fixture(t);
    let reviews = 0;
    const config = services();
    config.connector = async () => ({
      turn: async prompt => {
        reviews++;
        if (reviews > 1) assert.match(prompt, /Fix the concrete fixture issue/);
        return {
          status: 'completed',
          reply:
            reviews === 1
              ? {
                  ...review,
                  findings: [
                    {
                      severity: 'blocking',
                      description: 'Fix the concrete fixture issue',
                      evidence: 'Fixture regression must be rechecked',
                    },
                  ],
                }
              : review,
          usage: null,
          error: null,
        };
      },
      close: async () => {},
      interrupt: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create({ ...f.plan, reviewPolicy: { repairRounds: 1 } }),
      id = task.id;
    tasks.approve(id, 1, task.guided!.digest);
    await tasks.run(id);
    const first = await tasks.authorize(id);
    assert.equal(first.status, 'awaiting_assessment', first.note);
    const repair = await tasks.assess(id, 'passed', 'Inspected initial implementation');
    assert.equal(repair.status, 'awaiting_scope', repair.note);
    assert.equal(repair.reviewCycle!.repairs, 1);
    assert.notEqual(repair.executionId, first.executionId);
    assert.match(repair.feedback, /Fix the concrete/);
    const repairView = guidedTaskView(f.store, id);
    assert.equal(repairView.carriedFindings, true);
    assert.match(repairView.findings[0]!.description, /Fix the concrete/);
    assert.equal(f.store.deliveries(first.executionId!).length, 0);
    const second = await tasks.authorize(id);
    assert.equal(second.status, 'awaiting_assessment', second.note);
    const done = await tasks.assess(id, 'passed', 'Reinspected the repaired artifact and validation');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(reviews, 2);
  },
);

for (const passes of [true, false])
  test(
    `fresh approved arbitration ${passes ? 'passes with retained disagreement' : 'stops after an unresolved verdict'}`,
    windows,
    async t => {
      const f = fixture(t);
      let turns = 0;
      const blocking: Reply = {
        ...review,
        findings: [
          { severity: 'blocking', description: 'Concrete disagreement', evidence: 'The fixture contract is disputed' },
        ],
      };
      const config = services();
      config.connector = async provider => ({
        turn: async prompt => {
          turns++;
          if (turns === 2) {
            assert.equal(provider, 'codex');
            assert.match(prompt, /fresh arbitrator/);
            assert.match(prompt, /Concrete disagreement/);
          }
          return { status: 'completed', reply: turns === 2 && passes ? review : blocking, usage: null, error: null };
        },
        close: async () => {},
        interrupt: async () => {},
      });
      const tasks = new GuidedTasks(f.store, config),
        task = tasks.create({ ...f.plan, reviewPolicy: { repairRounds: 0, arbitrator: { provider: 'codex' } } }),
        id = task.id;
      tasks.approve(id, 1, task.guided!.digest);
      await tasks.run(id);
      await tasks.authorize(id);
      const result = await tasks.assess(id, 'passed', 'Inspected the submitted implementation');
      assert.equal(result.status, passes ? 'complete' : 'blocked', result.note);
      assert.equal(turns, 2);
      assert.equal(result.reviewCycle!.arbitrationUsed, true);
      assert.equal(result.reviewCycle!.history.length, passes ? 1 : 2);
      const history = renderReport(f.store, id);
      assert.match(history, /guided.arbitration_requested/);
      if (passes) assert.match(history, /review.same_provider_fallback/);
      else {
        assert.equal(f.store.deliveries(result.executionId!).length, 0);
        await assert.rejects(tasks.run(id), /blocked/);
      }
    },
  );

test(
  'a revision preserves delivered slice commits while continuing from explicitly approved partial edits',
  windows,
  async t => {
    const f = fixture(t),
      criteria = ['Print hello world with a newline', 'Preserve the greeting while completing the follow-up'];
    const plan = {
      ...f.plan,
      implementation: { provider: 'claude' },
      brief: {
        ...f.plan.brief,
        criteria,
        slices: [
          { title: 'Greeting', plan: 'Implement greeting', criteria: [criteria[0]!] },
          { title: 'Follow-up', plan: 'Verify greeting again', criteria: [criteria[1]!] },
        ],
      },
      slices: [f.plan.slices[0]!, { ...f.plan.slices[0]!, mode: 'no_change', scope: { files: [] } }],
    };
    const task = f.tasks.create(plan),
      id = task.id;
    f.tasks.approve(id, 1, task.guided!.digest);
    await f.tasks.run(id);
    await f.tasks.authorize(id);
    const second = await f.tasks.assess(id, 'passed', 'The first slice uses one direct statement');
    assert.equal(second.sliceIndex, 1);
    assert.equal(second.status, 'awaiting_scope', second.note);
    const delivered = new Workflow(f.store).get(id).slice!.completed[0]!;
    writeFileSync(join(f.plan.workspace.path, 'greeting.js'), "console.log('hello world'); // partial follow-up\n");
    const input = structuredClone(second.plan);
    input.brief.slices![1]!.plan = 'Finish the approved follow-up edit';
    input.slices[1]!.mode = 'commit';
    input.slices[1]!.scope = { files: ['greeting.js'] };
    input.slices[1]!.message = 'Finish follow-up';
    const wrong = structuredClone(input);
    wrong.slices[0]!.message = 'Rewrite delivered history';
    await assert.rejects(f.tasks.revise(id, wrong), /Delivered slices cannot/);
    const revised = await f.tasks.revise(id, input);
    assert.equal(revised.sliceIndex, 1);
    assert.equal(revised.status, 'draft');
    assert.deepEqual(new Workflow(f.store).get(id).slice!.completed, [delivered]);
    assert.equal(git(f.plan.workspace.path, 'rev-parse', 'HEAD'), delivered.head);
    const tasks = new GuidedTasks(f.store, services("console.log('hello world'); // completed follow-up\n"));
    tasks.approve(id, 2, revised.digest);
    const scope = await tasks.run(id);
    assert.equal(scope.status, 'awaiting_scope', scope.note);
    const assessed = await tasks.authorize(id);
    assert.equal(assessed.status, 'awaiting_assessment', assessed.note);
    const done = await tasks.assess(id, 'passed', 'The follow-up preserves the delivered contract');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(git(f.plan.workspace.path, 'rev-parse', 'HEAD^'), delivered.head);
    assert.deepEqual(guidedTaskView(f.store, id).checks.at(-1)!.spec.criteria, criteria);
  },
);

test('guided acceptance verifies JSON values and file bytes through supervised delivery', windows, async t => {
  const f = fixture(t),
    source = "console.log('hello world');\n";
  const task = f.tasks.create({
      ...f.plan,
      slices: [
        {
          ...f.plan.slices[0],
          acceptance: {
            file: 'node',
            args: ['-e', 'console.log(JSON.stringify({ok:true, count:2}))'],
            timeoutMs: 15000,
            expectations: {
              stdoutJson: { count: 2, ok: true },
              stderr: '',
              files: [{ path: 'greeting.js', content: source }],
            },
          },
        },
      ],
    }),
    id = task.id;
  f.tasks.approve(id, 1, task.guided!.digest);
  await f.tasks.run(id);
  await f.tasks.authorize(id);
  const done = await f.tasks.assess(id, 'passed', 'Verified the output statement and captured file observations');
  assert.equal(done.status, 'complete', done.note);
  assert.ok(guidedTaskView(f.store, id).checks.at(-1)!.spec.expectations?.files?.length);
});

test(
  'failed guided workspace creation releases only unused metadata and waits for explicit continuation',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create(),
      branch = `grampus/${id}`;
    git(f.repo, 'branch', branch);
    assert.throws(() =>
      execFileSync(process.execPath, [cli, '--db', f.store.path, 'task-run', id], { stdio: 'pipe', windowsHide: true }),
    );
    assert.equal(f.tasks.get(id).status, 'recovery_required');
    const released = await f.tasks.releaseWorkspace(id);
    assert.equal(released.status, 'ready');
    assert.equal(released.pending, null);
    assert.equal(released.owner, null);
    assert.equal(f.store.workspaces<import('../src/workspaces.js').Workspace>()[0]!.phase, 'released');
    assert.equal(f.store.executions().length, 0);
    const continued = await f.tasks.run(id);
    assert.equal(continued.status, 'awaiting_scope', continued.note);
    assert.equal(f.store.executions().length, 1);
    assert.equal(git(f.repo, 'rev-parse', branch), continued.plan.workspace.base);
  },
);

test('failed simplification is retained and cannot start independent review or delivery', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  const checkpoint = await f.tasks.authorize(id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const failed = await f.tasks.assess(id, 'skipped', 'Inspection still outstanding');
  assert.equal(failed.status, 'blocked', failed.note);
  assert.ok(
    new Workflow(f.store).get(id).evidence.some(item => item.kind === 'simplification' && item.outcome === 'skipped'),
  );
  assert.equal(
    f.store.executions<import('../src/execution-state.js').Execution>().filter(item => item.role === 'review').length,
    0,
  );
  assert.equal(f.store.deliveries(failed.executionId!).length, 0);
  await assert.rejects(f.tasks.run(id), /blocked/);
});

test('guided delivery verifies a larger repository while supplying only selected text context', windows, async t => {
  const f = fixture(t),
    asset = Buffer.alloc(1024 * 1024, 255);
  writeFileSync(join(f.repo, 'asset.bin'), asset);
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Existing binary asset');
  const plan = { ...f.plan, context: { files: ['greeting.js'] } };
  let reviewed = false;
  const configured = services();
  configured.connector = async () => ({
    turn: async prompt => {
      assert.match(prompt, /"omittedFiles":1/);
      assert.match(prompt, /NOT reviewed/);
      reviewed = true;
      return { status: 'completed', reply: review, usage: null, error: null };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const tasks = new GuidedTasks(f.store, configured),
    task = tasks.create(plan);
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const done = await tasks.assess(
    task.id,
    'passed',
    'One direct output statement, inspected with the existing repository instructions.',
  );
  assert.equal(done.status, 'complete', done.note);
  assert.equal(reviewed, true);
  const view = guidedTaskView(f.store, task.id);
  assert.deepEqual(readFileSync(join(view.workspace!.path!, 'asset.bin')), asset);
  assert.equal(git(view.workspace!.path!, 'status', '--porcelain'), '');
  assert.match(renderReport(f.store, task.id), /omittedFiles/);
});

test('stale scopes stop before dispatch while repository size is independent of selected context', windows, async t => {
  const f = fixture(t);
  let calls = 0;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    implementationRunner: async () => {
      calls++;
      throw new Error('Unexpected dispatch');
    },
  });
  const id = f.create();
  await tasks.run(id);
  const state = tasks.get(id),
    workspace = f.store.workspace<import('../src/workspaces.js').Workspace>(state.workspaceId!);
  writeFileSync(join(workspace.path!, 'greeting.js'), "console.log('external change');\n");
  const stopped = await tasks.authorize(id);
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(calls, 0);
  writeFileSync(join(f.repo, 'large.txt'), 'x'.repeat(256 * 1024));
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'Too large for guided review');
  const larger = tasks.create({
    ...f.plan,
    context: { files: ['greeting.js'] },
    workspace: { ...f.plan.workspace, path: join(f.root, 'another-workspace') },
  });
  assert.ok(larger.guided!.plan.context!.totalBytes > 256 * 1024);
  assert.deepEqual(larger.guided!.plan.context!.files, ['AGENTS.md', 'greeting.js']);
});

test('blocking review stops delivery and explicit retry uses fresh sessions with preserved files', windows, async t => {
  const f = fixture(t);
  let reviews = 0;
  const config = services();
  config.connector = async (_, options) => ({
    turn: async prompt => {
      assert.match(prompt, /repository/i);
      reviews++;
      options.emit({ type: 'session.connected', data: { providerSessionId: `review-${reviews}`, model: 'fixture' } });
      return {
        status: 'completed',
        reply:
          reviews === 1
            ? {
                ...review,
                findings: [
                  {
                    severity: 'blocking',
                    description: 'Fixture requests a repair review',
                    evidence: 'Concrete offline finding',
                  },
                ],
              }
            : review,
        usage: null,
        error: null,
      };
    },
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config),
    id = f.create();
  await tasks.run(id);
  await tasks.authorize(id);
  const failed = await tasks.assess(id, 'passed', 'One direct statement with no duplication');
  assert.equal(failed.status, 'blocked', failed.note);
  assert.equal(reviews, 1);
  assert.equal(f.store.deliveries(failed.executionId!).length, 0);
  const previous = f.store.execution<import('../src/execution-state.js').Execution>(failed.executionId!);
  const next = await tasks.retry(id);
  assert.equal(next.status, 'awaiting_scope', next.note);
  assert.notEqual(next.executionId, failed.executionId);
  assert.notEqual(
    f.store.execution<import('../src/execution-state.js').Execution>(next.executionId!).sessionId,
    previous.sessionId,
  );
  const workspace = f.store.workspace<import('../src/workspaces.js').Workspace>(next.workspaceId!);
  assert.equal(readFileSync(join(workspace.path!, 'greeting.js'), 'utf8'), "console.log('hello world');\n");
  assert.match(next.feedback, /Concrete offline finding/);
  const repaired = await tasks.authorize(id);
  assert.equal(repaired.status, 'awaiting_assessment', repaired.note);
  const done = await tasks.assess(id, 'passed', 'Reviewed the retained implementation and fresh validation again');
  assert.equal(done.status, 'complete', done.note);
  assert.equal(reviews, 2);
  assert.equal(new Workflow(f.store).get(id).approvedVersion, 1);
});

test('review questions persist and an explicit answer resumes the same independent session', windows, async t => {
  const f = fixture(t);
  let turns = 0;
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    connector: async (_, options) => ({
      turn: async prompt => {
        turns++;
        if (turns === 2) {
          assert.equal(options.providerSessionId, 'question-review');
          assert.match(prompt, /yes, this is the intended output/);
        }
        options.emit({ type: 'session.connected', data: { providerSessionId: 'question-review', model: 'fixture' } });
        return {
          status: 'completed',
          reply:
            turns <= 2
              ? {
                  kind: 'question',
                  text: 'Clarify one point',
                  questions: [
                    {
                      id: 'output',
                      prompt:
                        turns === 1
                          ? 'Is this output intended?'
                          : 'Confirm the output also applies to the final example?',
                      choices: ['yes'],
                    },
                  ],
                  findings: [],
                }
              : review,
          usage: null,
          error: null,
        };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  });
  const id = f.create();
  await tasks.run(id);
  await tasks.authorize(id);
  const questioned = await tasks.assess(id, 'passed', 'Inspected one direct statement');
  assert.equal(questioned.status, 'awaiting_answer', questioned.note);
  assert.equal(guidedTaskView(f.store, id).questions[0]!.id, 'output');
  await assert.rejects(tasks.answer(id, {}), /every pending/);
  await assert.rejects(tasks.run(id), /awaiting_answer/);
  assert.equal(turns, 1);
  const firstView = guidedTaskView(f.store, id),
    staleKey = guidedDecisionKey(firstView.state, firstView.questionKey);
  const secondQuestion = await tasks.answer(id, { output: 'yes, this is the intended output' });
  assert.equal(secondQuestion.status, 'awaiting_answer');
  assert.equal(turns, 2);
  const secondView = guidedTaskView(f.store, id);
  assert.notEqual(guidedDecisionKey(secondView.state, secondView.questionKey), staleKey);
  await assert.rejects(
    new GuidedTasks(f.store, { expectedState: staleKey }).answer(id, { output: 'stale answer' }),
    /changed/,
  );
  assert.equal(turns, 2);
  const done = await tasks.answer(id, { output: 'yes, including the final example' });
  assert.equal(done.status, 'complete', done.note);
  assert.equal(turns, 3);
  assert.equal(done.reviewId, questioned.reviewId);
});

test('no-change workflow runs every gate without implementation inference or a commit', windows, async t => {
  const f = fixture(t);
  const plan = structuredClone(f.plan);
  plan.brief.outcome = 'Confirm the existing hello greeting';
  plan.brief.criteria = ['Print hello with a newline'];
  plan.slices[0]!.validation.args = ['greeting.js'];
  plan.slices[0]!.acceptance.expectedStdout = 'hello\n';
  const input = { ...plan, slices: [{ ...plan.slices[0]!, scope: { files: [] }, mode: 'no_change' }] };
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    implementationRunner: async () => {
      throw new Error('No-change cannot call implementation');
    },
  });
  const task = tasks.create(input);
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  assert.equal(f.store.implementations(checkpoint.executionId!).length, 0);
  const done = await tasks.assess(task.id, 'passed', 'Existing fixture already uses one direct output statement');
  assert.equal(done.status, 'complete', done.note);
  const view = guidedTaskView(f.store, task.id);
  assert.equal(view.deliveries[0]!.outcome, 'no_change');
  assert.equal(view.deliveries[0]!.commit, null);
  assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD'), done.plan.workspace.base);
});

function crashProgram(
  f: ReturnType<typeof fixture>,
  action: 'authorize' | 'assess',
  nextStage: string,
  id: string,
  journalFailure = false,
): void {
  const file = join(f.root, `crash-${nextStage}.mjs`);
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  writeFileSync(
    file,
    `
    import {join} from 'node:path'; import {Store} from ${url('store')}; import {GuidedTasks} from ${url('guided-tasks')}; import {runCheckProcess} from ${url('check-process')};
    const message = ${JSON.stringify(message)}, review = ${JSON.stringify(review)};
    const serviceFactory = ${services.toString()};
    const store = new Store(${JSON.stringify(f.store.path)}); const append = store.append.bind(store);
    let failed = false;
    store.append = (id, version, type, data) => {
      if (!failed && type === 'guided.step_finished' && data.stage === ${JSON.stringify(nextStage)}) {
        failed = true;
        if (${journalFailure}) throw new Error('Injected guided journal failure');
        process.exit(29);
      }
      append(id, version, type, data);
    };
    const tasks = new GuidedTasks(store, serviceFactory());
    if (${JSON.stringify(nextStage)} === 'assessment_input') tasks.drive = async () => process.exit(29);
    const result = await tasks.${action}(${JSON.stringify(id)}${action === 'assess' ? ", 'passed', 'Offline explicit simplification'" : ''});
    if (${journalFailure} && result.status === 'recovery_required' && result.pending?.stage === 'delivery') process.exit(29);
    if (${journalFailure} && failed) throw new Error('Verified delivery lost its pending recovery intent: ' + result.status);
    throw new Error('Fault injection was not reached');
  `,
  );
  assert.throws(
    () => execFileSync(process.execPath, [file], { windowsHide: true, stdio: 'pipe' }),
    (error: unknown) => (error as { status: number }).status === 29,
  );
}

test(
  'a lost completed implementation is adopted without replay and continues only on explicit task-run',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    crashProgram(f, 'authorize', 'validation', id);
    const before = f.tasks.get(id);
    assert.equal(before.pending!.stage, 'implementation');
    assert.ok(before.owner);
    const runs = f.store.implementations<ImplementationRun>(before.executionId!);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.phase, 'completed');
    await assert.rejects(f.tasks.run(id), /running|uncertain/);
    const recovered = await f.tasks.recover(id);
    assert.equal(recovered.status, 'ready', recovered.note);
    assert.equal(recovered.stage, 'validation');
    assert.equal(recovered.owner, null);
    assert.equal(f.store.implementations(before.executionId!).length, 1);
    assert.equal(f.store.checks(before.executionId!).length, 0);
    await assert.rejects(f.tasks.recover(id), /No guided recovery/);
    const checkpoint = await f.tasks.run(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    const done = await f.tasks.assess(id, 'passed', 'Inspected preserved completed edit and real validation');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(f.store.implementations(before.executionId!).length, 1);
  },
);

for (const journalFailure of [false, true])
  test(
    `a lost verified delivery after ${journalFailure ? 'journal failure' : 'controller exit'} is adopted once without inference or Git replay`,
    windows,
    async t => {
      const f = fixture(t),
        id = f.create();
      await f.tasks.run(id);
      await f.tasks.authorize(id);
      crashProgram(f, 'assess', 'complete', id, journalFailure);
      const before = f.tasks.get(id);
      assert.equal(before.pending!.stage, 'delivery');
      const view = guidedTaskView(f.store, id),
        head = git(view.workspace!.path!, 'rev-parse', 'HEAD');
      assert.equal(view.task.phase, 'complete');
      assert.equal(view.deliveries[0]!.phase, 'delivered');
      const sessions = f.store.sessions().length;
      const done = await f.tasks.recover(id);
      assert.equal(done.status, 'complete', done.note);
      assert.equal(done.owner, null);
      assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD'), head);
      assert.equal(f.store.deliveries(before.executionId!).length, 1);
      assert.equal(f.store.sessions().length, sessions);
      await assert.rejects(f.tasks.recover(id), /No guided recovery/);
    },
  );

test(
  'an explicit assessment entered before a controller exit remains bound and requires explicit continuation',
  windows,
  async t => {
    const f = fixture(t),
      id = f.create();
    await f.tasks.run(id);
    const checkpoint = await f.tasks.authorize(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    crashProgram(f, 'assess', 'assessment_input', id);
    const before = f.tasks.get(id);
    assert.equal(before.pending, null);
    assert.equal(before.assessment!.summary, 'Offline explicit simplification');
    const recovered = await f.tasks.recover(id);
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.stage, 'assessment');
    assert.equal(recovered.reviewId, null);
    assert.equal(
      new Workflow(f.store).get(id).evidence.filter(item => item.kind === 'simplification' && item.outcome === 'passed')
        .length,
      0,
    );
    const done = await f.tasks.run(id);
    assert.equal(done.status, 'complete', done.note);
    assert.equal(
      new Workflow(f.store).get(id).evidence.find(item => item.kind === 'simplification' && item.outcome === 'passed')!
        .summary,
      'Offline explicit simplification',
    );
  },
);

test('one guided task owns execution and a cross-process stop request settles its actual tool', windows, async t => {
  const f = fixture(t),
    id = f.create();
  const other = f.tasks.create({
    ...f.plan,
    workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') },
  });
  f.tasks.approve(other.id, 1, other.guided!.digest);
  let started!: () => void;
  const entered = new Promise<void>(resolve => {
    started = resolve;
  });
  const tasks = new GuidedTasks(f.store, {
    ...services(),
    implementationRunner: options =>
      runCheckProcess({
        ...options,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        started: (kind, pid) => {
          options.started(kind, pid);
          if (kind === 'tool') started();
        },
      }),
  });
  await tasks.run(id);
  const running = tasks.authorize(id);
  await entered;
  await assert.rejects(tasks.run(other.id), /Another guided task/);
  await assert.rejects(tasks.recover(id), /still alive/);
  execFileSync(process.execPath, [cli, '--db', f.store.path, 'task-stop', id], { windowsHide: true, stdio: 'pipe' });
  const stopped = await running;
  assert.equal(stopped.status, 'blocked', stopped.note);
  assert.equal(stopped.owner, null);
  assert.equal(f.store.implementations<ImplementationRun>(stopped.executionId!)[0]!.phase, 'interrupted');
  assert.equal(f.store.lease(stopped.workspaceId!), null);
  const prepared = await tasks.run(other.id);
  assert.equal(prepared.status, 'awaiting_scope', prepared.note);
});

test('unknown native shutdown retains global ownership and cannot admit another guided task', windows, async t => {
  const f = fixture(t),
    id = f.create();
  const other = f.tasks.create({
    ...f.plan,
    workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') },
  });
  f.tasks.approve(other.id, 1, other.guided!.digest);
  const tasks = new GuidedTasks(f.store, {
    implementationRunner: async () => ({
      reason: 'supervisor_lost',
      exitCode: null,
      exitConfirmed: false,
      stdout: '',
      stderr: '',
      outputTruncated: false,
    }),
  });
  await tasks.run(id);
  const uncertain = await tasks.authorize(id);
  assert.equal(uncertain.status, 'recovery_required');
  assert.ok(uncertain.owner);
  assert.ok(uncertain.pending);
  assert.ok(f.store.lease(uncertain.workspaceId!));
  await assert.rejects(tasks.run(other.id), /Another guided task/);
  await assert.rejects(tasks.retry(id), /recover uncertain/);
  await assert.rejects(tasks.recover(id), /still alive/);
});

test(
  'implementation questions require explicit answers and a fresh scope authorization before another turn',
  windows,
  async t => {
    const f = fixture(t);
    let calls = 0;
    const question: Reply = {
      kind: 'question',
      text: 'Confirm greeting',
      questions: [{ id: 'wording', prompt: 'Use hello world?', choices: ['yes'] }],
      findings: [],
    };
    const tasks = new GuidedTasks(f.store, {
      ...services(),
      implementationRunner: options => {
        calls++;
        const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as { prompt: string };
        if (calls === 2) assert.match(request.prompt, /yes, hello world/);
        return services(
          calls === 1 ? "console.log('partial');\n" : "console.log('hello world');\n",
          calls === 1 ? question : message,
        ).implementationRunner!(options);
      },
    });
    const id = f.create();
    await tasks.run(id);
    const questioned = await tasks.authorize(id);
    assert.equal(questioned.status, 'awaiting_answer', questioned.note);
    assert.equal(calls, 1);
    const answered = await tasks.answer(id, { wording: 'yes, hello world' });
    assert.equal(answered.status, 'awaiting_scope', answered.note);
    assert.equal(calls, 1);
    assert.notEqual(answered.policy!.artifact, questioned.policy!.artifact);
    const checkpoint = await tasks.authorize(id);
    assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
    assert.equal(calls, 2);
    const done = await tasks.assess(id, 'passed', 'Inspected the final direct greeting statement after answering');
    assert.equal(done.status, 'complete', done.note);
  },
);

test(
  'deletion-only retries validate retained deletion with fresh gates and no empty editing policy',
  windows,
  async t => {
    const f = fixture(t),
      marker = join(f.root, 'validation-attempted');
    let implementations = 0;
    const configured = services();
    configured.implementationRunner = options => {
      implementations++;
      return runCheckProcess({
        ...options,
        args: [
          '-e',
          `const fs=require('node:fs');fs.unlinkSync('greeting.js');
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))},JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));`,
        ],
      });
    };
    const tasks = new GuidedTasks(f.store, configured);
    const task = tasks.create({
      ...f.plan,
      brief: {
        title: 'Remove greeting',
        outcome: 'Remove the obsolete greeting',
        criteria: ['greeting.js is absent'],
        plan: 'Delete, validate, review and deliver',
      },
      slices: [
        {
          scope: { files: [], delete: ['greeting.js'] },
          validation: {
            file: 'node',
            args: [
              '-e',
              `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'attempted');process.exit(7)};require('node:assert/strict').equal(fs.existsSync('greeting.js'),false);`,
            ],
          },
          acceptance: {
            file: 'node',
            args: [
              '-e',
              "require('node:assert/strict').equal(require('node:fs').existsSync('greeting.js'),false);console.log('absent');",
            ],
            expectedStdout: 'absent\n',
          },
          message: 'Remove obsolete greeting',
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    await tasks.run(task.id);
    const failed = await tasks.authorize(task.id);
    assert.equal(failed.status, 'blocked', failed.note);
    const retried = await tasks.retry(task.id);
    assert.equal(retried.status, 'awaiting_scope', retried.note);
    assert.notEqual(retried.executionId, failed.executionId);
    assert.equal(retried.policy, null);
    const assessed = await tasks.authorize(task.id);
    assert.equal(assessed.status, 'awaiting_assessment', assessed.note);
    assert.equal(implementations, 1);
    const done = await tasks.assess(
      task.id,
      'passed',
      'The retained deletion is complete and fresh validation confirms absence',
    );
    assert.equal(done.status, 'complete', done.note);
    assert.equal(git(guidedTaskView(f.store, task.id).workspace!.path!, 'status', '--porcelain'), '');
    assert.equal(guidedTaskView(f.store, task.id).deliveries[0]!.outcome, 'committed');
  },
);

test(
  'three large planned slices page cumulative review and require separate assessments and final whole-task acceptance',
  windows,
  async t => {
    const f = fixture(t);
    writeFileSync(join(f.repo, 'cli.js'), "console.log('pending');\n");
    writeFileSync(join(f.repo, 'notes.js'), 'module.exports = null;\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'CLI fixture baseline');
    const criteria = [
      'Library exposes hello world',
      'CLI prints hello world with a newline',
      'Notes expose the documented contract',
    ];
    const libraryCheck =
      "require('node:assert/strict').equal(require('./greeting.js'),'hello world');console.log('library ok');";
    const allCheck =
      libraryCheck +
      "require('node:assert/strict').equal(require('node:child_process').execFileSync(process.execPath,['cli.js'],{encoding:'utf8'}),'hello world\\n');console.log('cli ok');";
    const finalCheck =
      allCheck + "require('node:assert/strict').equal(require('./notes.js'),'documented');console.log('notes ok');";
    const plan = {
      ...f.plan,
      brief: {
        ...f.plan.brief,
        criteria,
        slices: [
          { title: 'Library', plan: 'Expose the greeting', criteria: [criteria[0]!] },
          { title: 'CLI integration', plan: 'Reuse the library and verify both', criteria: [criteria[1]!] },
          {
            title: 'Notes and final integration',
            plan: 'Document the contract and verify all criteria',
            criteria: [criteria[2]!],
          },
        ],
      },
      slices: [
        {
          scope: { files: ['greeting.js'] },
          validation: { file: 'node', args: ['-e', libraryCheck], timeoutMs: 15000 },
          acceptance: { file: 'node', args: ['-e', libraryCheck], expectedStdout: 'library ok\n', timeoutMs: 15000 },
          message: 'Expose greeting library',
        },
        {
          scope: { files: ['cli.js'] },
          validation: { file: 'node', args: ['-e', allCheck], timeoutMs: 15000 },
          acceptance: {
            file: 'node',
            args: ['-e', allCheck],
            expectedStdout: 'library ok\ncli ok\n',
            timeoutMs: 15000,
          },
          message: 'Integrate greeting CLI',
        },
        {
          scope: { files: ['notes.js'] },
          validation: { file: 'node', args: ['-e', finalCheck], timeoutMs: 15000 },
          acceptance: {
            file: 'node',
            args: ['-e', finalCheck],
            expectedStdout: 'library ok\ncli ok\nnotes ok\n',
            timeoutMs: 15000,
          },
          message: 'Document and verify greeting',
        },
      ],
    };
    const tasks = new GuidedTasks(f.store, {
      ...services(),
      implementationRunner: options => {
        const run = f.store.implementation<ImplementationRun>(options.receipt!.checkId);
        const file = run.policy.files[0]!,
          source =
            file === 'greeting.js'
              ? "module.exports = 'hello world';\n"
              : file === 'cli.js'
                ? "console.log(require('./greeting.js'));\n"
                : "module.exports = 'documented';\n";
        return runCheckProcess({
          ...options,
          args: [
            '-e',
            `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(source)}+'//'+ 'x'.repeat(190*1024));
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))},JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));`,
          ],
        });
      },
      connector: async (_, options) => ({
        turn: async prompt => {
          assert.ok(Buffer.byteLength(prompt) < 2 * 1024 * 1024);
          const access = options.repository!;
          assert.ok('snapshot' in access);
          const read = repositoryTools(access, options.emit, () => true);
          if ('snapshot' in access)
            for (const change of access.snapshot.diff)
              for (const side of ['before', 'after'] as const) {
                let offset: number | null = 0,
                  content = '';
                while (offset !== null) {
                  const page = read('grampus_read_changes', { path: change.path, side, offset }) as {
                    content: string | null;
                    nextOffset: number | null;
                  };
                  content += page.content ?? '';
                  offset = page.nextOffset;
                }
                assert.equal(content, (side === 'before' ? change.previousContent : change.content) ?? '');
              }
          return { status: 'completed', reply: review, usage: null, error: null };
        },
        close: async () => {},
        interrupt: async () => {},
      }),
    });
    const kickoffs = new Kickoffs(f.store, async () => ({
      turn: async () => ({
        status: 'completed',
        reply: { ...message, text: JSON.stringify(plan) },
        usage: null,
        error: null,
      }),
      interrupt: async () => {},
      close: async () => {},
    }));
    const kickoffId = kickoffs.create({
      repo: f.repo,
      request: 'Deliver the full greeting library and CLI task in sequential slices',
    });
    const proposal = await kickoffs.send(kickoffId);
    assert.equal(proposal.error, null);
    const id = kickoffs.prepare(kickoffId, proposal.candidateDigest!),
      draft = tasks.get(id);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.plan.slices.length, 3);
    tasks.approve(id, draft.version, draft.digest);
    await tasks.run(id);
    const first = await tasks.authorize(id);
    assert.equal(first.status, 'awaiting_assessment', first.note);
    const next = await tasks.assess(id, 'passed', 'One exported string; the CLI remains for the next slice');
    assert.equal(next.status, 'awaiting_scope', next.note);
    assert.equal(next.sliceIndex, 1);
    assert.notEqual(next.executionId, first.executionId);
    const firstDelivery = f.store.deliveries<import('../src/deliveries.js').Delivery>(first.executionId!)[0]!;
    const workspace = guidedTaskView(f.store, id).workspace!;
    const libraryBlob = git(workspace.path!, 'rev-parse', 'HEAD:greeting.js');
    await tasks.authorize(id);
    const third = await tasks.assess(id, 'passed', 'The CLI reuses the delivered library with one output statement');
    assert.equal(third.status, 'awaiting_scope', third.note);
    assert.equal(third.sliceIndex, 2);
    const finalAssessment = await tasks.authorize(id);
    assert.equal(finalAssessment.status, 'awaiting_assessment', finalAssessment.note);
    const done = await tasks.assess(id, 'passed', 'The documented contract and final integration are consistent');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(git(workspace.path!, 'rev-parse', 'HEAD~2'), firstDelivery.commit);
    assert.equal(git(workspace.path!, 'rev-parse', 'HEAD:greeting.js'), libraryBlob);
    assert.deepEqual(guidedTaskView(f.store, id).checks.at(-1)!.spec.criteria, criteria);
    assert.equal(new Workflow(f.store).get(id).slice!.completed.length, 3);
  },
);

for (const gate of ['validation', 'acceptance'] as const)
  test(`a failing ${gate} command is retained and cannot reach delivery or replay itself`, windows, async t => {
    const f = fixture(t);
    if (gate === 'validation') f.plan.slices[0]!.validation.args = ['-e', 'process.exit(7)'];
    else f.plan.slices[0]!.acceptance.expectedStdout = 'unexpected output\n';
    const id = f.create();
    await f.tasks.run(id);
    let result = await f.tasks.authorize(id);
    if (gate === 'acceptance') {
      assert.equal(result.status, 'awaiting_assessment', result.note);
      result = await f.tasks.assess(id, 'passed', 'Inspected the one direct statement');
    }
    assert.equal(result.status, 'blocked', result.note);
    assert.equal(result.owner, null);
    assert.equal(f.store.deliveries(result.executionId!).length, 0);
    const view = guidedTaskView(f.store, id);
    assert.equal(view.checks.at(-1)!.phase, 'failed');
    if (gate === 'validation') assert.equal(view.checks.at(-1)!.result!.exitCode, 7);
    else assert.ok(view.task.evidence.some(item => item.kind === 'verification' && item.outcome === 'failed'));
    const attempts = f.store.implementations(result.executionId!).length,
      checks = view.checks.length;
    await assert.rejects(f.tasks.run(id), /blocked/);
    assert.equal(f.store.implementations(result.executionId!).length, attempts);
    assert.equal(f.store.checks(result.executionId!).length, checks);
  });

test('recovery refuses a completed result with a different file authorization', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  crashProgram(f, 'authorize', 'validation', id);
  const before = f.tasks.get(id),
    run = f.store.implementations<ImplementationRun>(before.executionId!)[0]!;
  f.store.saveImplementation(run.id, run.executionId, { ...run, policy: { ...run.policy, files: ['AGENTS.md'] } });
  const refused = await f.tasks.recover(id);
  assert.equal(refused.status, 'recovery_required');
  assert.match(refused.note, /differs from the authorized file policy/);
  assert.ok(refused.pending);
  assert.ok(refused.owner);
  assert.equal(f.store.checks(before.executionId!).length, 0);
  assert.equal(f.store.deliveries(before.executionId!).length, 0);
});
