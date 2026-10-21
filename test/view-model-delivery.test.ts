// View model scenarios over real guided task journals: a repaired review through verified delivery (every
// stage passed with its evidence source, quality passes, usage nulls, recent deliveries) and a silent
// running check (working, stalled, stop and pause controls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { availableQualityPasses } from '../src/domain/quality-passes.js';
import { StallWatchdog } from '../src/health/stalls.js';
import { healthView } from '../src/health/health.js';
import type { ViewContext } from '../src/server/view-model/context.js';
import { taskDetail, taskFacts } from '../src/server/view-model/task-detail.js';
import { overview } from '../src/server/view-model/overview.js';
import type { TaskDetailV1 } from '../src/server/api-types.js';
import { windows, services, fixture, review, lens, resolvedFindings } from './helpers/guided-tasks.js';
import { profile } from './helpers/model-profiles.js';

const idlePool = { active: 0, limit: 2, owners: [] };

function context(stall: ViewContext['stall'] = () => null): ViewContext {
  return { job: () => null, stall, qualityPasses: availableQualityPasses(), pool: idlePool };
}

function detail(f: ReturnType<typeof fixture>, id: string, view = context()): TaskDetailV1 {
  return taskDetail(taskFacts(f.store, id), view, f.store.revision());
}

function home(f: ReturnType<typeof fixture>, id: string, view = context()) {
  return overview(
    {
      tasks: [taskFacts(f.store, id)],
      unreadable: [],
      kickoffs: [],
      health: healthView(f.store),
      application: { version: '0.0.0', channel: 'development', build: null },
      journal: f.store.path,
      qualityPasses: availableQualityPasses(),
    },
    view,
    f.store.revision(),
  );
}

const stage = (view: TaskDetailV1, id: string) => view.workflow.find(item => item.id === id);
const action = (view: TaskDetailV1, id: string) => view.decisions.find(item => item.id === id);

test('a review repair through delivery shows every stage passed with its evidence source', windows, async t => {
  const f = fixture(t);
  let edits = 0,
    reviews = 0;
  const config = services();
  // Implementation, the refactor pass, then the review repair: the repair changes the bytes the
  // reviewer blocked, since unchanged bytes cannot resolve their own blockers.
  config.implementationRunner = options => {
    edits++;
    return services(
      edits === 1
        ? "// needless explanation\nconsole.log('hello world');\n"
        : edits === 2
          ? "console.log('hello world'); // prints the greeting\n"
          : "console.log('hello world');\n",
    ).implementationRunner!(options);
  };
  config.connector = async () => ({
    turn: async prompt => ({
      status: 'completed' as const,
      reply: {
        ...review,
        priorFindings: resolvedFindings(prompt),
        lenses: [
          ++reviews === 1
            ? lens('fail', 'Remove the comment that repeats the output statement.')
            : lens('pass', 'The direct output statement now stands on its own.'),
        ],
      },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    quality: { passes: ['simplification', 'refactor'] },
    modelProfile: { ...profile, qualityPasses: { refactor: profile.implementation } },
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);

  const view = detail(f, task.id);
  assert.equal(view.header.status, 'complete');
  assert.equal(view.header.statusLabel, 'Delivered locally');
  assert.deepEqual(view.header.nextStep, { kind: 'none', label: 'Delivered locally. Nothing else is needed.' });
  assert.deepEqual(
    view.workflow.map(item => [item.id, item.state, item.evidence]),
    [
      ['plan', 'passed', null],
      ['implement', 'passed', 'agent-reported'],
      ['quality:refactor', 'passed', 'agent-reported'],
      ['validate', 'passed', 'controller-verified'],
      ['accept', 'passed', 'controller-verified'],
      ['review', 'passed', 'agent-reported'],
      ['deliver', 'passed', 'controller-verified'],
    ],
  );
  assert.equal(stage(view, 'implement')!.detail, '1 repair');
  assert.deepEqual(
    stage(view, 'review')!.items.map(item => [item.id, item.state, item.evidence]),
    [['lens:simplification', 'passed', 'agent-reported']],
  );
  assert.equal(action(view, 'report')!.kind, 'primary');
  assert.deepEqual(action(view, 'report')!.request, {
    method: 'GET',
    path: `/api/tasks/${task.id}/report`,
    body: null,
  });
  assert.equal(view.results.commits.length, 1);
  assert.match(view.results.commits[0]!.commit ?? '', /^[0-9a-f]{40}$/);
  assert.deepEqual(
    view.results.criteria.map(item => item.state),
    ['passed'],
  );
  assert.deepEqual(view.results.unresolved, []);
  assert.ok(view.usage.turns >= 2);
  assert.equal(view.usage.headline.tokens, null);
  assert.ok(view.usage.providers.every(row => row.inputTokens === null && row.completeness === 'none'));

  const summary = home(f, task.id);
  assert.deepEqual(summary.attention, []);
  assert.equal(summary.tasks[0]?.status, 'complete');
  assert.equal(summary.tasks[0]?.stageLabel, 'Delivered');
  assert.equal(summary.recentDeliveries.length, 1);
  assert.equal(summary.recentDeliveries[0]?.commit, view.results.commits[0]!.commit);
  assert.match(summary.recentDeliveries[0].evidence, /verified by Grampus; independent review by Claude/);
});

test('a silent running check is working, stalled and offers stop and pause controls', windows, async t => {
  const f = fixture(t);
  const release = join(f.root, 'release-check');
  const config = services();
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed' as const,
      reply: { ...review, lenses: [lens('pass', 'One direct output statement.')] },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    slices: [
      {
        ...f.plan.slices[0]!,
        validation: {
          name: 'Waiting validation',
          file: 'node',
          args: [
            '-e',
            `const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},50);`,
          ],
          timeoutMs: 30000,
        },
      },
    ],
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const running = tasks.run(task.id);
  try {
    const started = Date.now();
    const runningCheck = () =>
      f.store
        .executions()
        .filter(execution => execution.taskId === task.id)
        .flatMap(execution => f.store.checks(execution.id))
        .find(check => check.phase === 'running' && check.purpose === 'validation');
    while (!runningCheck() && Date.now() - started < 20000) await delay(50);
    assert.ok(runningCheck(), 'validation started');
    const watchdog = new StallWatchdog(f.store, () => Date.now() + 600_000);
    watchdog.scan(600_000);
    const view = detail(
      f,
      task.id,
      context(id => watchdog.stall(id)),
    );
    assert.equal(view.header.status, 'working');
    assert.match(view.header.explanation, /outside this dashboard/);
    assert.equal(view.header.stalled?.owner, 'check Waiting validation');
    assert.equal(view.activity?.actor, 'check');
    assert.equal(view.activity?.description, 'Running Waiting validation');
    assert.equal(stage(view, 'validate')!.state, 'active');
    assert.equal(view.header.nextStep.kind, 'automatic');
    assert.deepEqual(
      view.decisions.filter(item => item.enabled).map(item => item.id),
      ['stop', 'recover', 'pause', 'report'],
    );
    const items = home(
      f,
      task.id,
      context(id => watchdog.stall(id)),
    ).attention;
    assert.deepEqual(
      items.map(item => [item.kind, item.actions.map(entry => entry.id)]),
      [['stalled', ['stop']]],
    );
    assert.match(items[0]!.why, /Nothing has been stopped/);
  } finally {
    writeFileSync(release, '');
    await running;
  }
  assert.ok(existsSync(release));
});
