// The System page's judgement: drivers that stopped, are busy or run an older build, workers that went
// quiet, Orca not answering, and agent providers near their usage limits, each as a problem with an id that
// stays the same while it lasts. Orca is checked at most once per `healthProbeMs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHealth, OrcaProbe, type HealthInput, type ProbeResult } from '../src/dashboard/health.js';
import type { StoredEvent, TaskEvent } from '../src/domain/events.js';
import { standardRecipe } from '../src/domain/recipe.js';
import type { ProviderLimits } from '../src/orca/protocol.js';
import { foldEvents } from '../src/pipeline/state.js';
import { FakeOrca } from './helpers/fake-orca.js';
import { useTestSettings } from './helpers/task-fixture.js';

const now = Date.parse('2026-10-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function taskLog(taskId: string, events: [number, TaskEvent][]): StoredEvent[] {
  const created: [number, TaskEvent][] = [
    [120, { type: 'log.header', schema: 1 }],
    [
      120,
      {
        type: 'task.created',
        taskId,
        title: `Task ${taskId}`,
        request: 'R',
        repoPath: 'C:/repo',
        recipe: standardRecipe,
      },
    ],
  ];
  return [...created, ...events].map(([minutes, event]) => ({ ...event, at: minutesAgo(minutes) }));
}

const started = (build?: string): TaskEvent => ({
  type: 'driver.started',
  pid: 1,
  orcaVersion: null,
  terminal: null,
  ...(build ? { build } : {}),
});

const okProbe: ProbeResult = {
  orca: {
    ok: true,
    version: '1.4',
    state: 'ready',
    appRunning: true,
    latencyMs: 40,
    error: null,
    checkedAt: minutesAgo(0),
  },
  providers: [],
  providersError: null,
};

function input(overrides: Partial<HealthInput>): HealthInput {
  return {
    now,
    tasks: [],
    comparisons: [],
    unreadable: [],
    probe: okProbe,
    grampus: { dashboard: '0.8.0+new', installed: '0.8.0+new' },
    recipes: [standardRecipe],
    ...overrides,
  };
}

const alive = { pid: 1, touchedAt: minutesAgo(0), alive: true };

test('a quiet system is ok', () => {
  useTestSettings();
  const health = buildHealth(input({}));
  assert.equal(health.level, 'ok');
  assert.deepEqual(health.problems, []);
});

test('a stopped driver is an error, and a busy or outdated one a warning', () => {
  useTestSettings();
  const stopReason = 'long-poll capacity reached\n    at OrcaCli.call (client.js:169:19)';
  const stoppedEvents = taskLog('a', [
    [60, started('0.8.0+new')],
    [50, { type: 'driver.stopped', reason: stopReason }],
  ]);
  const busyEvents = taskLog('b', [
    [60, started('0.8.0+old')],
    [30, { type: 'orca.busy', detail: 'inbox check' }],
    [20, { type: 'orca.room', waitedMs: 600_000 }],
    [10, { type: 'orca.busy', detail: 'worker-start' }],
  ]);
  const health = buildHealth(
    input({
      tasks: [
        { state: foldEvents(stoppedEvents), events: stoppedEvents, heartbeat: null },
        { state: foldEvents(busyEvents), events: busyEvents, heartbeat: alive },
      ],
    }),
  );

  const [stopped, busy] = health.drivers;
  assert.equal(stopped?.state, 'stopped');
  assert.equal(stopped?.stop?.reason, stopReason);
  assert.equal(busy?.state, 'alive');
  assert.equal(busy?.busySince, minutesAgo(10), 'busy since the spell that has not ended');
  assert.equal(busy?.outdated, true);
  assert.equal(health.level, 'error');
  assert.equal(
    health.problems[0]?.detail,
    'long-poll capacity reached',
    'the stack trace is left to the drivers table',
  );
  assert.deepEqual(
    health.problems.map(problem => [problem.level, problem.id]),
    [
      ['error', `driver:a:${minutesAgo(50)}`],
      ['warning', `orca-busy:${minutesAgo(10)}`],
      ['warning', 'outdated:0.8.0+new'],
    ],
  );
  assert.deepEqual(
    health.hiccups.map(hiccup => hiccup.kind),
    ['busy', 'room', 'busy', 'stopped'],
    'newest first',
  );
});

test('a dashboard on an older build than the installed one says so', () => {
  useTestSettings();
  const health = buildHealth(input({ grampus: { dashboard: '0.8.0+old', installed: '0.8.0+new' } }));
  assert.deepEqual(
    health.problems.map(problem => problem.id),
    ['dashboard:0.8.0+new'],
  );
});

test('a worker with nothing to say for too long is quiet; one asking the user is not', () => {
  useTestSettings({ stalledWorkerMs: 30 * 60_000 });
  const stage = (key: string, dispatchId: string, minutes: number): [number, TaskEvent][] => [
    [minutes, { type: 'stage.created', key, stage: 'build', round: 0, orcaTaskId: `o-${key}` }],
    [
      minutes,
      {
        type: 'stage.started',
        key,
        dispatchId,
        assignment: { agent: 'codex' },
        reusedHandle: null,
        launch: { requested: null, effective: { agent: 'codex', model: 'gpt-6.1-sol' } },
      },
    ],
  ];
  const events = taskLog('a', [
    [90, started()],
    ...stage('build:0', 'd1', 60),
    ...stage('spec:1', 'd2', 60),
    [55, { type: 'worker.message', messageId: 'm1', key: 'spec:1', kind: 'question', subject: 'Q', body: 'Q?' }],
  ]);
  const health = buildHealth(input({ tasks: [{ state: foldEvents(events), events, heartbeat: alive }] }));

  assert.deepEqual(
    health.workers.map(worker => [worker.stageKey, worker.state, worker.model]),
    [
      ['build:0', 'quiet', 'gpt-6.1-sol'],
      ['spec:1', 'asking', 'gpt-6.1-sol'],
    ],
  );
  assert.deepEqual(
    health.problems.map(problem => problem.id),
    ['quiet:d1'],
  );
});

test('providers in use are judged by their limits; unused unavailable ones are left out', () => {
  useTestSettings({ providerUsageWarnPercent: 90 });
  const provider = (name: string, overrides: Partial<ProviderLimits> = {}): ProviderLimits => ({
    provider: name,
    status: 'ok',
    error: null,
    ...overrides,
  });
  const resetsAt = now + 3_600_000;
  const health = buildHealth(
    input({
      probe: {
        ...okProbe,
        providers: [
          provider('claude', {
            session: { usedPercent: 46, resetsAt, resetDescription: '23:00' },
            weekly: { usedPercent: 92, resetsAt, resetDescription: 'Sun 03:00' },
          }),
          provider('codex', { weekly: { usedPercent: 100, resetsAt, resetDescription: 'Thu 19:47' } }),
          provider('grok', { status: 'unavailable', error: 'Not signed in' }),
        ],
      },
    }),
  );

  assert.deepEqual(
    health.providers?.map(entry => entry.provider),
    ['claude', 'codex'],
  );
  assert.deepEqual(
    health.problems.map(problem => [problem.level, problem.title]),
    [
      ['error', 'codex has reached its weekly limit'],
      ['warning', 'claude has used 92% of its weekly limit'],
    ],
  );
});

test('Orca is checked once per probe interval, and an unreachable Orca is an error', async () => {
  useTestSettings({ healthProbeMs: 60_000 });
  const orca = new FakeOrca(() => 'hang');
  orca.orcaStatus = null;
  const probe = new OrcaProbe(orca);
  const first = await probe.get(now);
  await probe.get(now + 1_000);
  assert.equal(orca.healthChecks, 1, 'the second request reused the first check');
  assert.equal(first.orca.ok, false);
  assert.deepEqual(
    buildHealth(input({ probe: first })).problems.map(problem => [problem.level, problem.id]),
    [['error', 'orca']],
  );

  orca.orcaStatus = { appRunning: true, reachable: true, state: 'ready', version: '1.4' };
  assert.equal((await probe.get(now + 60_000)).orca.ok, true, 'checked again once the interval passed');
});
