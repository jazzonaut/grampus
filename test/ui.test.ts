import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startUi } from '../src/server/ui-server.js';
import { currentSettings, useSettings } from '../src/config/settings.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { Store } from '../src/persistence/store.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedSnapshot } from '../src/orchestration/guided/snapshots.js';
import { Sessions } from '../src/execution/sessions.js';
import type { Connector, Reply } from '../src/providers/types.js';
import type { RepositoryCheck } from '../src/verification/checks.js';
import type {
  KickoffDetailV1,
  OverviewV1,
  TaskDetailV1,
  TimelineEntryV1,
  TimelinePageV1,
} from '../src/server/api-types.js';
import { connect, offered, settled } from './helpers/dashboard.js';

function fixture(_t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-')),
    repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  git('config', 'user.name', 'Offline test');
  git('config', 'user.email', 'offline@example.invalid');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const plan = {
    workflowPolicy: { mode: 'supervised' },
    brief: {
      title: 'Verify greeting',
      outcome: 'Confirm hello with a newline',
      criteria: ['Greeting prints hello followed by a newline'],
      plan: 'Check existing behavior and independently review without changes',
    },
    workspace: { repo, path: join(root, 'workspace') },
    slices: [
      {
        mode: 'no_change',
        scope: { files: [] },
        validation: { file: 'node', args: ['--check', 'greeting.js'] },
        acceptance: [{ file: 'node', args: ['greeting.js'], expectedStdout: 'hello\n' }],
        message: 'Confirm greeting',
      },
    ],
  };
  return { root, repo, plan, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('dashboard polls show the actual failure without raw logs and page logs only on request', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store),
    task = tasks.create(f.plan);
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const state = tasks.get(task.id),
    raw = 'HUGE_RAW_LOG '.repeat(5000) + '\n\x1b[31mAssertionError: MarkInfo must follow its reference\x1b[0m';
  // A complete record: the store validates every check it reads back.
  const check: RepositoryCheck = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    executionId: state.executionId!,
    phase: 'failed',
    spec: {
      ...state.plan.slices[0]!.validation,
      artifact: state.snapshot!.artifact,
      instructionsDigest: state.snapshot!.instructionsDigest,
    },
    before: guidedSnapshot(ui.store, state),
    after: guidedSnapshot(ui.store, state),
    supervisorPid: null,
    toolPid: null,
    error: null,
    purpose: 'validation',
    dispatch: 'requested',
    result: { stdout: '', stderr: raw, reason: 'exited', exitCode: 1, exitConfirmed: true, outputTruncated: false },
  };
  ui.store.saveCheck(check.id, check.executionId, check);
  const saved = ui.store.get(task.id);
  saved.guided!.status = 'blocked';
  saved.guided!.stage = 'validation';
  saved.guided!.note = raw;
  ui.store.save(task.id, saved);
  const url = new URL(ui.url),
    headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const response = await fetch(`${url.origin}/api/v1/tasks/${task.id}`, { headers }),
    payload = await response.text(),
    view = JSON.parse(payload) as TaskDetailV1;
  assert.match(view.header.note!, /MarkInfo/);
  assert.ok(view.header.note!.length < 4000);
  assert.equal('stderr' in view.results.checks[0]!, false);
  assert.equal('before' in view.results.checks[0]!, false);
  assert.doesNotMatch(payload, /HUGE_RAW_LOG|\\u001b/);
  const page = await (
    await fetch(`${url.origin}/api/tasks/${task.id}/check-output?checkId=${check.id}&offset=59000`, { headers })
  ).json();
  assert.match(page.content, /MarkInfo/);
  assert.ok(!page.content.includes('\u001b'), 'no raw escape sequences');
  assert.ok(page.content.length <= 16000);
  const other = tasks.create({ ...f.plan, workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') } });
  assert.equal(
    (await fetch(`${url.origin}/api/tasks/${other.id}/check-output?checkId=${check.id}`, { headers })).status,
    404,
  );
});

test('approving an automatic plan starts work without a second continue or file authorization click', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store),
    task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      slices: [{ ...f.plan.slices[0], validation: { file: 'node', args: ['-e', 'process.exit(1)'] } }],
    });
  const api = connect(ui);
  const draft = await api.task(task.id);
  const response = await api.act(offered(draft, 'approve'));
  assert.equal(response.status, 202);
  await settled(ui, task.id);
  const state = tasks.get(task.id),
    view = await api.task(task.id);
  assert.equal(state.status, 'blocked', state.note);
  assert.equal(state.stage, 'validation');
  assert.equal(view.results.checks[0]!.state, 'failed');
  assert.ok(!view.decisions.some(item => item.id === 'rerun-checks'), 'A genuine check failure is not offered a rerun');
  assert.ok(!ui.store.events(task.id).some(event => (event.data as any)?.status === 'awaiting_scope'));
});

test('a timed-out check offers Rerun checks, which runs a new check through a worker without a new attempt', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store),
    task = tasks.create({
      ...f.plan,
      workflowPolicy: { mode: 'automatic' },
      slices: [
        {
          ...f.plan.slices[0],
          validation: { file: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 1000 },
        },
      ],
    });
  tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id);
  const api = connect(ui);
  assert.deepEqual(
    (await api.overview()).qualityPasses.map(pass => pass.id),
    ['simplification', 'naming', 'refactor', 'documentation'],
  );
  let view = await api.task(task.id);
  assert.equal(view.header.stopReason?.code, 'CHECK_TIMEOUT', view.header.note ?? '');
  const rerun = offered(view, 'rerun-checks');
  assert.equal(rerun.enabled, true);
  const attempt = ui.store.get(task.id).attempt!.id;
  const response = await api.act(rerun);
  assert.equal(response.status, 202);
  const deadline = Date.now() + 30000;
  do {
    await new Promise(resolve => setTimeout(resolve, 100));
    view = await api.task(task.id);
  } while ((ui.job(task.id)?.running || view.results.checks.length < 2) && Date.now() < deadline);
  assert.equal(ui.job(task.id)?.error, null);
  assert.equal(view.results.checks.length, 2);
  assert.notEqual(view.results.checks[1]!.id, view.results.checks[0]!.id);
  assert.equal(view.header.stopReason?.code, 'CHECK_TIMEOUT');
  assert.equal(ui.store.get(task.id).attempt!.id, attempt);
  assert.ok(ui.store.events(task.id).some(event => event.type === 'guided.checks_rerun_requested'));
});

test('planning gives native setup ownership on initial and resumed turns and retains explicit prerequisites', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'preparation.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  const before = { name: 'Restore toolchain', file: 'node', args: ['-e', "console.log('restore')"], timeoutMs: 600000 };
  const after = {
    name: 'Refresh generated inputs',
    file: 'node',
    args: ['-e', "console.log('refresh')"],
    timeoutMs: 300000,
  };
  const plan = { ...f.plan, preparation: before, slices: [{ ...f.plan.slices[0], preparation: after }] };
  const prompts: string[] = [];
  const kickoffs = new Kickoffs(store, async () => {
    return {
      turn: async prompt => {
        prompts.push(prompt);
        return {
          status: 'completed',
          usage: null,
          error: null,
          reply:
            prompts.length === 1
              ? {
                  kind: 'question',
                  text: 'Confirm behavior',
                  questions: [{ id: 'confirm', prompt: 'Preserve the greeting?', choices: ['yes'] }],
                  findings: [],
                }
              : { kind: 'message', text: JSON.stringify(plan), questions: [], findings: [] },
        };
      },
      close: async () => {},
      interrupt: async () => {},
    };
  });
  const id = kickoffs.create({ repo: f.repo, request: 'Verify existing behavior' });
  await kickoffs.send(id);
  const proposed = await kickoffs.send(id, undefined, { confirm: 'yes' });
  assert.equal(proposed.error, null);
  for (const prompt of prompts) {
    assert.match(prompt, /use native shell, file, browser and debugging tools/);
    assert.match(prompt, /install dependencies and generate lockfiles itself/);
    assert.doesNotMatch(prompt, /implementer cannot run commands/);
  }
  assert.deepEqual(proposed.candidate!.preparation!.args, before.args);
  assert.deepEqual(proposed.candidate!.slices[0]!.preparation!.args, after.args);
  const tasks = new GuidedTasks(store),
    taskId = kickoffs.prepare(id, proposed.candidateDigest!);
  const draft = tasks.get(taskId);
  assert.equal(draft.status, 'draft');
  assert.equal(store.workspaces().length, 0);
  const changed = tasks.create({
    ...plan,
    preparation: { ...before, args: ['-e', "console.log('different restore')"] },
  });
  assert.notEqual(changed.guided!.digest, draft.digest);
  assert.throws(() => tasks.approve(taskId, 1, changed.guided!.digest), /current draft version and guided plan digest/);
});

for (const location of ['initial', 'slice'] as const)
  test(`planning rejects invalid generated ${location} preparation before approval`, async t => {
    const f = fixture(t),
      store = new Store(join(f.root, 'invalid-preparation.sqlite'));
    t.after(() => {
      store.close();
      f.cleanup();
    });
    const invalid = { name: 'Invalid restore', file: 'node', args: ['-e', 'const broken = ;'] };
    const plan = {
      ...f.plan,
      ...(location === 'initial' ? { preparation: invalid } : {}),
      slices: [{ ...f.plan.slices[0], ...(location === 'slice' ? { preparation: invalid } : {}) }],
    };
    const kickoffs = new Kickoffs(store, async () => {
      return {
        turn: async () => ({
          status: 'completed',
          usage: null,
          error: null,
          reply: { kind: 'message', text: JSON.stringify(plan), questions: [], findings: [] },
        }),
        close: async () => {},
        interrupt: async () => {},
      };
    });
    const view = await kickoffs.send(kickoffs.create({ repo: f.repo, request: 'Verify greeting' }));
    assert.match(view.error!, /Invalid restore.*invalid JavaScript/);
    assert.equal(view.candidate, null);
    assert.equal(store.list().length, 0);
    assert.equal(store.workspaces().length, 0);
  });

test('a failed dashboard action is journaled on its task and survives a dashboard restart', async t => {
  const f = fixture(t),
    database = join(f.root, 'grampus.sqlite');
  let ui = await startUi({ db: database, port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const { id } = new GuidedTasks(ui.store).create(f.plan);
  const draft = await connect(ui).task(id);
  // Running an unapproved plan is refused by the controller inside the worker.
  const key = offered(draft, 'approve').expected;
  assert.equal((await connect(ui).post(`/api/tasks/${id}/run`, { expected: key })).status, 202);
  const job = await settled(ui, id, 30_000);
  assert.match(job?.error ?? '', /Approve the exact guided plan/);
  assert.doesNotMatch(job?.error ?? '', /reasonCode/, 'the structured report is shown as its message');
  const shown = await connect(ui).task(id);
  assert.match(shown.header.actionError?.message ?? '', /Approve the exact guided plan/);
  const failure = ui.store.events(id).find(event => event.type === 'dashboard.action_failed');
  assert.ok(failure, 'the failure is in the task journal');
  assert.deepEqual(
    { ...(failure.data as Record<string, unknown>), note: undefined },
    { action: 'run', note: undefined, reasonCode: null, exitCode: 1 },
  );
  assert.match((failure.data as { note: string }).note, /Approve the exact guided plan/);
  await ui.close();
  ui = await startUi({ db: database, port: 0 });
  const reopened = await connect(ui).task(id);
  assert.ok(
    reopened.details.timeline.recent.some(
      entry => entry.type === 'dashboard.action_failed' && /Approve the exact/.test(entry.note ?? ''),
    ),
  );
  assert.equal(reopened.header.actionError?.action, 'run', 'the journaled failure is shown after a restart');
  assert.match(reopened.header.actionError?.message ?? '', /Approve the exact/);
  assert.equal(ui.job(id), null);
});

test('task polling refreshes live usage written by another worker without changing approval decisions', async t => {
  const f = fixture(t),
    database = join(f.root, 'grampus.sqlite'),
    ui = await startUi({ db: database, port: 0 });
  const writer = new Store(database);
  t.after(async () => {
    writer.close();
    await ui.close();
    f.cleanup();
  });
  const { id } = new GuidedTasks(ui.store).create(f.plan);
  const sessions = new Sessions(writer),
    session = sessions.create('claude', f.repo);
  writer.append(id, 1, 'guided.kickoff_linked', { sessionId: session.id });
  const claim = sessions.claim(session.id, 'Measure usage');
  const api = connect(ui);
  const get = () => api.task(id);
  const key = (view: TaskDetailV1) => offered(view, 'approve').expected;
  const before = await get();
  assert.equal(before.usage.providers[0]!.observedSessions, 0);
  const observe = (inputTokens: number) =>
    sessions.event(session.id, claim.runId, {
      type: 'usage.updated',
      data: {
        scope: 'provider-session-cumulative',
        complete: false,
        inputTokens,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 3,
        estimatedCostUsd: 0.01,
        billedCostUsd: null,
      },
    });
  observe(7);
  const first = await get();
  assert.equal(first.usage.providers[0]!.inputTokens, 7);
  observe(11);
  const next = await get();
  assert.equal(next.usage.providers[0]!.inputTokens, 11);
  assert.equal(next.usage.providers[0]!.observedSessions, 1);
  assert.equal(next.usage.providers[0]!.activeSessions, 1);
  assert.equal(key(next), key(before));
  sessions.settle(session.id, claim.runId, { status: 'interrupted', reply: null, usage: null, error: 'Stopped' }, true);
  const stopped = await get();
  assert.equal(stopped.usage.providers[0]!.inputTokens, 11);
  assert.equal(stopped.usage.providers[0]!.activeSessions, 0);
  assert.equal(stopped.usage.providers[0]!.cacheWriteInputTokens, 3);
  assert.equal(stopped.usage.stages[0]!.stage, 'planning');
  assert.equal(stopped.usage.stages[0]!.interruptedTurns, 1);
  assert.equal(stopped.usage.turns, 1);
});

test('task polls expose current execution activity and load complete sanitized history separately', async t => {
  const previous = currentSettings();
  useSettings({ ...previous, dashboardRequireAccessLink: true });
  t.after(() => useSettings(previous));
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store),
    { id } = tasks.create(f.plan);
  const draft = tasks.get(id);
  tasks.approve(id, draft.version, draft.digest);
  await tasks.run(id);
  const task = ui.store.get(id);
  task.guided!.stage = 'implementation';
  task.guided!.status = 'running';
  // A runner owns the task, as a worker would while the turn runs; the view shows it as working.
  task.guided!.owner = { token: 'offline-owner', controllerPid: process.pid, controllerStartedAt: null, host: 'test' };
  ui.store.save(id, task);
  const execution = ui.store.execution(task.guided!.executionId!);
  const sessions = new Sessions(ui.store),
    claim = sessions.claim(execution.sessionId, 'HIDDEN PROMPT');
  const api = connect(ui);
  const get = () => api.task(id);
  const key = (view: TaskDetailV1) => offered(view, 'reset').expected;
  const initial = await get();
  assert.ok(initial.activity, 'a claimed turn is current activity');
  sessions.event(execution.sessionId, claim.runId, {
    type: 'tool.authorized',
    data: { tool: 'Edit', path: 'greeting.js', new_string: 'HIDDEN EDIT' },
  });
  const working = await get();
  assert.equal(working.activity?.fileRequests, 1);
  assert.equal(working.activity?.description, 'Requested file changes: greeting.js');
  assert.equal(key(working), key(initial));
  assert.doesNotMatch(JSON.stringify(working.activity), /HIDDEN/);
  for (let i = 0; i < 45; i++)
    ui.store.append(id, task.version, 'test.activity', { note: `Activity ${i}`, prompt: 'HIDDEN EVENT DATA' });
  const compact = await get();
  assert.equal(compact.details.timeline.total, ui.store.events(id).length);
  assert.ok(compact.details.timeline.recent.length < compact.details.timeline.total);
  const entries: TimelineEntryV1[] = [];
  for (let cursor: number | null = null, pages = 0; pages === 0 || cursor !== null; pages++) {
    const page: TimelinePageV1 = await api.read(
      `${compact.details.timeline.path}?limit=20${cursor === null ? '' : `&cursor=${cursor}`}`,
    );
    entries.push(...page.entries);
    cursor = page.nextCursor;
  }
  assert.equal(entries.length, compact.details.timeline.total);
  assert.equal(entries.at(-1)?.type, ui.store.events(id)[0]!.type, 'oldest last');
  assert.equal(entries[0]?.note, 'Activity 44', 'newest first');
  assert.doesNotMatch(JSON.stringify(entries), /HIDDEN|"plan":|"prompt":/);
  assert.equal((await fetch(`${api.origin}${compact.details.timeline.path}`)).status, 401);
  sessions.settle(
    execution.sessionId,
    claim.runId,
    {
      status: 'completed',
      reply: { kind: 'message', text: 'Done', questions: [], findings: [] },
      usage: null,
      error: null,
    },
    true,
  );
  assert.equal((await get()).activity?.fileRequests ?? null, null, 'no live agent progress after the turn settled');
});

test('dashboard revisions run in an isolated worker and stale approval cannot approve the new version', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store),
    task = tasks.create(f.plan),
    id = task.id;
  const api = connect(ui);
  const original = await api.task(id),
    revise = offered(original, 'revise');
  // The form's JSON field carries the whole plan; the client writes edits into it at the field targets.
  const plan = structuredClone(revise.form!.fields.find(item => item.name === 'plan')!.value) as any;
  plan.brief.outcome = 'Revised observable output';
  plan.workflowPolicy.repairRounds = 1;
  plan.reviewPolicy = { arbitrator: { provider: 'codex' } };
  assert.equal((await api.act(revise, { expected: 'stale', plan })).status, 409);
  assert.equal((await api.act(revise, { plan })).status, 202);
  assert.equal((await settled(ui, id, 15_000))?.error, null);
  const state = tasks.get(id),
    revised = await api.task(id);
  assert.equal(state.version, 2);
  assert.equal(state.status, 'draft');
  assert.equal(state.plan.workflowPolicy.repairRounds, 1);
  assert.equal(revised.details.approval.version, 2);
  assert.equal(ui.store.workspaces().length, 0);
  assert.equal(ui.store.sessions().length, 0);
  assert.equal((await api.act(offered(original, 'approve'))).status, 409);
  assert.equal((await api.act(offered(revised, 'approve'))).status, 200);
});

test('workspace confirmation requires no exact file grant when the task has no initial file hints', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store);
  const { id } = tasks.create({
    ...f.plan,
    context: { files: [] },
    slices: [{ ...f.plan.slices[0], mode: 'commit', scope: { files: ['greeting.js'] } }],
  });
  const draft = tasks.get(id);
  tasks.approve(id, draft.version, draft.digest);
  await tasks.run(id);
  assert.equal(tasks.get(id).status, 'awaiting_scope');
  const view = await connect(ui).task(id);
  assert.equal(view.details.scope?.error, null);
  assert.deepEqual(view.details.plan.context.files, []);
  assert.deepEqual(view.details.scope?.files, []);
  assert.match(offered(view, 'authorize').description, /native/i);
  assert.equal(offered(view, 'authorize').enabled, true);
});

test('large tracked text reaches native workspace confirmation without an exact file grant', async t => {
  const f = fixture(t),
    text = 'entry: value\n'.repeat(32000);
  writeFileSync(join(f.repo, 'dependency-data.yaml'), text);
  f.git('add', '.');
  f.git('commit', '-m', 'Add large tracked text');
  const ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const tasks = new GuidedTasks(ui.store);
  const { id } = tasks.create({
    ...f.plan,
    context: { files: [] },
    slices: [{ ...f.plan.slices[0], mode: 'commit', scope: { files: ['dependency-data.yaml'] } }],
  });
  const draft = tasks.get(id);
  tasks.approve(id, draft.version, draft.digest);
  const state = await tasks.run(id);
  assert.equal(state.status, 'awaiting_scope', state.note);
  const view = await connect(ui).task(id);
  assert.equal(view.details.scope?.error, null);
  assert.deepEqual(view.details.scope?.files, []);
  assert.equal(ui.store.implementations(state.executionId!).length, 0);
});

test('dashboard reference selection and task reset/delete enforce displayed state', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  const reference = join(f.root, 'reference');
  mkdirSync(reference);
  writeFileSync(join(reference, 'spec.md'), 'External contract');
  const api = connect(ui);
  const suggestions = await (await api.post('/api/references/suggest', { request: `Use ${reference}` })).json();
  assert.equal(suggestions.suggestions.length, 1);
  const { id } = await (
    await api.post('/api/kickoffs', { repo: f.repo, request: 'Original request', references: [reference] })
  ).json();
  let item = await api.kickoff(id);
  assert.equal(item.references.length, 1);
  const update = offered(item, 'update-references');
  assert.equal((await api.act(update, { references: [], expected: 'stale' })).status, 409);
  assert.equal((await api.act(update, { references: [] })).status, 200);
  item = await api.kickoff(id);
  assert.deepEqual(item.references, []);
  assert.equal((await api.act(offered(item, 'delete'), { expected: 'stale' })).status, 409);
  const reset = await (await api.act(offered(item, 'reset'))).json();
  item = await api.kickoff(reset.id);
  assert.equal(item.request, 'Original request');
  assert.equal(new Kickoffs(ui.store).view(reset.id).session.providerSessionId, null);
  assert.deepEqual(
    (await api.overview()).planning.map(entry => entry.id),
    [reset.id],
  );
  assert.equal((await api.act(offered(item, 'delete'))).status, 200);
  assert.deepEqual((await api.overview()).planning, []);
  const task = new GuidedTasks(ui.store).create(f.plan),
    view = await api.task(task.id);
  assert.equal((await api.act(offered(view, 'delete'))).status, 200);
  assert.deepEqual((await api.overview()).tasks, []);
  assert.equal((await api.raw(`/api/v1/tasks/${task.id}`)).status, 404);
  assert.equal(existsSync(join(f.repo, 'greeting.js')), true);
});
test('dashboard requires its local token and origin, rejects stale decisions, and preserves drafts over restart', async t => {
  const previous = currentSettings();
  useSettings({ ...previous, dashboardRequireAccessLink: true });
  t.after(() => useSettings(previous));
  const f = fixture(t),
    db = join(f.root, 'grampus.sqlite');
  let ui = await startUi({ db, port: 0 });
  t.after(async () => {
    await ui.close();
    f.cleanup();
  });
  let url = new URL(ui.url),
    base = url.origin,
    token = url.hash.slice(1);
  const req = (path: string, payload?: unknown) =>
    fetch(base + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  assert.equal((await fetch(base + '/api/v1/overview')).status, 401);
  assert.equal((await fetch(base + '/api/kickoffs', { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(base + '/api/v1/overview', {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' },
      })
    ).status,
    403,
  );
  const rebound = await new Promise<number>(resolve => {
    const req = request(
      base + '/api/v1/overview',
      { headers: { Authorization: `Bearer ${token}`, Host: 'rebound.example' } },
      response => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await req('/api/tasks', { plan: f.plan })).status, 201);
  const list = (await (await req('/api/v1/overview')).json()) as OverviewV1,
    id = list.tasks[0]!.id;
  assert.equal(list.application.version, '0.7.0');
  assert.equal(list.application.channel, 'development');
  const view = (await (await req(`/api/v1/tasks/${id}`)).json()) as TaskDetailV1;
  assert.equal(new GuidedTasks(ui.store).get(id).status, 'draft');
  assert.equal(view.details.plan.base, f.git('rev-parse', 'HEAD'));
  const approve = offered(view, 'approve');
  assert.equal((await req(approve.request.path, { ...approve.request.body, expected: 'stale' })).status, 409);
  assert.equal(ui.store.workspaces().length, 0);
  assert.equal((await req(approve.request.path, approve.request.body)).status, 200);
  await assert.rejects(new GuidedTasks(ui.store, { expectedState: approve.expected! }).run(id), /changed/);
  assert.equal(ui.store.workspaces().length, 0);
  assert.equal((await req(approve.request.path, approve.request.body)).status, 409);
  await ui.close();
  ui = await startUi({ db, port: 0 });
  url = new URL(ui.url);
  base = url.origin;
  token = url.hash.slice(1);
  const reopened = (await (await req(`/api/v1/tasks/${id}`)).json()) as TaskDetailV1;
  assert.equal(reopened.header.status, 'idle');
  assert.equal(reopened.details.approval.approved, true);
  assert.equal(ui.store.get(id).approvedVersion, 1);
  assert.match((await (await req(`/api/tasks/${id}/report`)).json()).report, /Verify greeting/);
  const connector: Connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
      usage: null,
      error: null,
    }),
    close: async () => {},
    interrupt: async () => {},
  });
  const planners = new Kickoffs(ui.store, connector);
  const kickoff = await (await req('/api/kickoffs', { repo: f.repo, request: 'Confirm greeting' })).json();
  const planned = await planners.send(kickoff.id);
  const prepare = `/api/kickoffs/${kickoff.id}/prepare`;
  assert.equal((await req(prepare, { digest: 'stale' })).status, 409);
  assert.equal((await req(prepare, { digest: planned.candidateDigest })).status, 201);
  assert.equal((await req(prepare, { digest: planned.candidateDigest })).status, 400);
  assert.equal(ui.store.workspaces().length, 0);
});

test(
  'dashboard workers use real file/check checkpoints without bypassing assessment or replaying clicks',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t),
      ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
    t.after(async () => {
      await ui.close();
      f.cleanup();
    });
    const api = connect(ui);
    const tasks = new GuidedTasks(ui.store);
    const { id } = await (await api.post('/api/tasks', { plan: f.plan })).json();
    const wait = async () => {
      assert.equal((await settled(ui, id))?.error ?? null, null);
      return api.task(id);
    };
    let view = await api.task(id);
    await api.act(offered(view, 'approve'));
    view = await api.task(id);
    const run = offered(view, 'run');
    assert.equal((await api.act(run)).status, 202);
    assert.equal((await api.act(run)).status, 409);
    view = await wait();
    assert.equal(tasks.get(id).status, 'awaiting_scope', tasks.get(id).note);
    assert.equal(view.details.plan.context.exploration, true);
    assert.deepEqual(view.details.scope?.files, []);
    assert.equal((await api.act(offered(view, 'authorize'))).status, 202);
    view = await wait();
    assert.equal(tasks.get(id).status, 'awaiting_assessment', tasks.get(id).note);
    assert.equal(view.results.checks[0]!.state, 'passed');
    assert.equal(view.results.commits.length, 0);
    await api.act(offered(view, 'assess'), {
      outcome: 'failed',
      summary: 'Offline UI test deliberately refuses the simplification gate.',
    });
    view = await wait();
    const state = tasks.get(id);
    assert.equal(state.status, 'blocked');
    assert.equal(view.results.commits.length, 0);
    assert.equal(state.reviewId, null);
    assert.equal(f.git('rev-parse', 'HEAD'), state.plan.workspace.base);
  },
);

test('dashboard exposes live planner activity across polls without changing the displayed decision', async t => {
  const f = fixture(t),
    ui = await startUi({ db: join(f.root, 'grampus.sqlite'), port: 0 });
  let markStarted!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });
  let emit!: Parameters<Connector>[1]['emit'];
  const connector: Connector = async (_, options) => {
    emit = options.emit;
    emit({ type: 'session.connected', data: { providerSessionId: 'offline-progress', model: null } });
    return {
      turn: async () => {
        emit({ type: 'turn.started', data: {} });
        markStarted();
        await finished;
        return {
          status: 'completed',
          reply: {
            kind: 'question',
            text: 'Please confirm the output',
            questions: [{ id: 'output', prompt: 'Keep hello?', choices: ['yes'] }],
            findings: [],
          },
          usage: null,
          error: null,
        };
      },
      close: async () => {},
      interrupt: async () => {},
    };
  };
  const kickoffs = new Kickoffs(ui.store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Check the greeting', provider: 'claude' });
  const sending = kickoffs.send(id);
  t.after(async () => {
    finish();
    await sending;
    await ui.close();
    f.cleanup();
  });
  await started;
  const api = connect(ui);
  const get = () => api.kickoff(id);
  const turnKey = (view: KickoffDetailV1) => offered(view, 'delete').expected;
  const first = await get();
  assert.equal(first.activity?.title, 'Agent is working');
  assert.equal(first.usage.headline.tokens, null);
  const sample = (inputTokens: number) =>
    emit({
      type: 'usage.updated',
      data: {
        scope: 'provider-session-cumulative',
        complete: false,
        inputTokens,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheWriteInputTokens: null,
        estimatedCostUsd: null,
        billedCostUsd: null,
      },
    });
  sample(100);
  emit({ type: 'repository.tool_requested', data: { tool: 'grampus_read_file', arguments: { path: 'greeting.js' } } });
  emit({
    type: 'repository.tool_result',
    data: { tool: 'grampus_read_file', result: { path: 'greeting.js', lines: ['HIDDEN FILE CONTENT'] } },
  });
  emit({ type: 'output.delta', data: { text: 'HIDDEN PARTIAL RESPONSE' } });
  // Streamed text is journaled in batches, within one flush interval.
  let updated = await get();
  for (
    const deadline = Date.now() + 10_000;
    updated.activity?.title !== 'Writing a response' && Date.now() < deadline;
  ) {
    await new Promise(resolve => setTimeout(resolve, 50));
    updated = await get();
  }
  assert.equal(turnKey(updated), turnKey(first));
  assert.equal(updated.activity?.title, 'Writing a response');
  assert.equal(updated.activity?.repositoryCalls, 1);
  assert.equal(updated.activity?.recent[0], 'Read greeting.js');
  assert.doesNotMatch(JSON.stringify(updated.activity), /HIDDEN/);
  assert.equal(updated.activity?.startedAt, first.activity?.startedAt);
  assert.equal(updated.usage.headline.tokens, 105);
  assert.equal(updated.usage.headline.completeness, 'live');
  sample(200);
  const measured = await get();
  assert.equal(measured.usage.headline.tokens, 205);
  assert.equal(turnKey(measured), turnKey(first));
  finish();
  await sending;
  const done = await get();
  assert.equal(done.activity, null);
  assert.equal(done.status, 'awaiting_human');
  assert.equal(done.usage.headline.tokens, 205);
  assert.equal(done.usage.headline.completeness, 'partial');
  assert.deepEqual(
    done.questions.map(question => question.id),
    ['output'],
  );
  assert.notEqual(turnKey(done), turnKey(first));
});

test('kickoff clarifies consequential ambiguity, validates generated commands and creates only an unapproved draft', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  const replies: Reply[] = [
    {
      kind: 'question',
      text: 'Which greeting should be preserved?',
      questions: [{ id: 'greeting', prompt: 'Which exact greeting?', choices: ['hello', 'hello world'] }],
      findings: [],
    },
    { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
    { kind: 'message', text: 'This is not a validated plan.', questions: [], findings: [] },
    { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
  ];
  let seen = '';
  const connector: Connector = async (_, options) => {
    return {
      turn: async prompt => {
        seen += prompt;
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: 'offline-planner', model: 'offline-fixture' },
        });
        return { status: 'completed', reply: replies.shift()!, usage: null, error: null };
      },
      close: async () => {},
      interrupt: async () => {},
    };
  };
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({
      repo: f.repo,
      request: 'Verify the greeting',
      provider: 'claude',
      contextFiles: ['greeting.js'],
    });
  assert.equal(store.list().length, 0);
  assert.equal(store.workspaces().length, 0);
  const question = await kickoffs.send(id);
  assert.equal(question.session.phase, 'awaiting_answer');
  assert.match(seen, /console.log\('hello'\)/);
  assert.match(seen, /Pinned repository/);
  assert.throws(() => kickoffs.prepare(id), /questions/);
  const answered = await kickoffs.send(id, undefined, { greeting: 'hello' });
  assert.equal(answered.error, null);
  assert.equal(answered.candidate!.implementation.provider, 'claude');
  assert.equal(answered.candidate!.review.provider, 'codex');
  assert.equal(answered.candidate!.workspace.base, f.git('rev-parse', 'HEAD'));
  assert.deepEqual(answered.candidate!.implementation, { provider: 'claude', model: null });
  assert.throws(() => kickoffs.prepare(id, 'outdated-proposal'), /changed/);
  assert.match(seen, /User answers/);
  const corrected = await kickoffs.send(id, 'Revise the checks');
  assert.equal(corrected.error, null);
  assert.ok(corrected.candidate);
  assert.match(seen, /Controller validation rejected/);
  const taskId = kickoffs.prepare(id),
    task = store.get(taskId);
  assert.equal(task.guided!.status, 'draft');
  assert.equal(task.approvedVersion, null);
  assert.equal(store.workspaces().length, 0);
  assert.equal(kickoffs.view(id).taskId, taskId);
  assert.throws(() => kickoffs.prepare(id), /already/);
  await assert.rejects(kickoffs.send(id, 'Change it after conversion'), /already/);
});

test('kickoff plans the full ticket across ordered slices on initial and resumed turns', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  const criteria = ['Greeting has valid JavaScript syntax', ...f.plan.brief.criteria];
  const plan = {
    ...f.plan,
    brief: {
      ...f.plan.brief,
      criteria,
      slices: [
        { title: 'Syntax', plan: 'Verify the existing script parses', criteria: [criteria[0]!] },
        { title: 'Output and integration', plan: 'Verify the output and all task criteria', criteria: [criteria[1]!] },
      ],
    },
    slices: [
      { ...f.plan.slices[0]!, acceptance: [{ file: 'node', args: ['--check', 'greeting.js'], expectedStdout: '' }] },
      f.plan.slices[0]!,
    ],
  };
  const incomplete = structuredClone(plan);
  incomplete.brief.slices[1]!.criteria = [criteria[0]!];
  const replies: Reply[] = [
    {
      kind: 'question',
      text: 'Confirm the intended output',
      questions: [{ id: 'output', prompt: 'Preserve hello with a newline?', choices: ['yes'] }],
      findings: [],
    },
    { kind: 'message', text: JSON.stringify(incomplete), questions: [], findings: [] },
    { kind: 'message', text: JSON.stringify(plan), questions: [], findings: [] },
  ];
  const prompts: string[] = [];
  const connector: Connector = async (_, options) => {
    return {
      turn: async prompt => {
        prompts.push(prompt);
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: 'offline-multislice-planner', model: 'fixture' },
        });
        return { status: 'completed', reply: replies.shift()!, usage: null, error: null };
      },
      close: async () => {},
      interrupt: async () => {},
    };
  };
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Plan this XL ticket in full: verify greeting syntax and output' });
  const question = await kickoffs.send(id);
  assert.equal(question.session.phase, 'awaiting_answer');
  assert.doesNotMatch(prompts[0]!, /Use one slice\./);
  const proposed = await kickoffs.send(id, undefined, { output: 'yes' });
  assert.equal(proposed.error, null);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2]!, /Slices must cover every task criterion/);
  for (const prompt of prompts) {
    assert.match(prompt, /1–64 ordered slices/);
    assert.match(prompt, /brief\.slices/);
    assert.match(prompt, /final slice.*every task criterion/);
  }
  assert.deepEqual(proposed.candidate!.brief.slices, plan.brief.slices);
  const taskId = kickoffs.prepare(id, proposed.candidateDigest!),
    tasks = new GuidedTasks(store),
    draft = tasks.get(taskId);
  assert.equal(draft.status, 'draft');
  assert.equal(store.get(taskId).approvedVersion, null);
  assert.equal(draft.plan.slices.length, 2);
  assert.deepEqual(draft.plan.brief.criteria, criteria);
  assert.equal(store.workspaces().length, 0);
  tasks.approve(taskId, draft.version, draft.digest);
  assert.equal(tasks.get(taskId).status, 'ready');
  assert.deepEqual(tasks.get(taskId).plan.brief.slices, plan.brief.slices);
});

test('kickoff omits binary assets and rejects their explicit selection before inference', t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  writeFileSync(join(f.repo, 'binary.bin'), Buffer.from([0, 1, 2]));
  f.git('add', '.');
  f.git('commit', '-m', 'Binary fixture');
  const kickoffs = new Kickoffs(store);
  assert.throws(
    () => kickoffs.create({ repo: f.repo, request: 'Change something', contextFiles: ['binary.bin'] }),
    /UTF-8/,
  );
  assert.equal(store.sessions().length, 0);
  const id = kickoffs.create({ repo: f.repo, request: 'Change greeting' });
  assert.deepEqual(kickoffs.view(id).config.files, []);
  assert.equal(kickoffs.view(id).config.context.omittedFiles, 2);
});

test('generated inline checks with broken newline escaping are rejected before a task or command can run', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  f.plan.slices[0]!.validation.args = ['-e', "require('node:assert/strict').equal('hello\n', 'hello\n')"];
  const connector: Connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
      usage: null,
      error: null,
    }),
    close: async () => {},
    interrupt: async () => {},
  });
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Verify the greeting' });
  const view = await kickoffs.send(id);
  assert.match(view.error!, /invalid JavaScript/);
  assert.equal(view.candidate, null);
  assert.throws(() => kickoffs.prepare(id), /errors/);
  assert.equal(store.list().length, 0);
  assert.equal(store.workspaces().length, 0);
});

// Regression: a valid `import` check was refused as "Cannot use import statement outside a module",
// although Node runs ES module syntax in `-e`, by detection or with --input-type=module.
test('generated inline checks are compiled the way Node runs them, including ES modules', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  const plan = (args: string[]) => {
    const candidate = structuredClone(f.plan);
    candidate.slices[0]!.validation.args = args;
    return candidate;
  };
  const propose = async (args: string[]) => {
    const connector: Connector = async () => ({
      turn: async () => ({
        status: 'completed',
        reply: { kind: 'message', text: JSON.stringify(plan(args)), questions: [], findings: [] },
        usage: null,
        error: null,
      }),
      close: async () => {},
      interrupt: async () => {},
    });
    const kickoffs = new Kickoffs(store, connector);
    return kickoffs.send(kickoffs.create({ repo: f.repo, request: 'Verify the greeting' }));
  };
  const esm = "import assert from 'node:assert/strict';assert.equal(1, 1);console.log('ok');";
  const detected = await propose(['-e', esm]);
  assert.equal(detected.error, null, 'Node detects module syntax in -e');
  assert.ok(detected.candidate);
  const explicit = await propose(['--input-type=module', '-e', `${esm}await Promise.resolve();`]);
  assert.equal(explicit.error, null, 'explicit module input, including top-level await');
  const commonjs = await propose(['--input-type=commonjs', '-e', esm]);
  assert.match(commonjs.error!, /invalid JavaScript/, 'explicit CommonJS input refuses import');
  const broken = await propose([
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict';assert.equal(1,",
  ]);
  assert.match(broken.error!, /invalid JavaScript/);
  assert.doesNotMatch(broken.error!, /outside a module/, 'a module syntax error is reported as such');
});

test('a planned acceptance check without observations is refused naming its slice, and the prompt requires them', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  const { expectedStdout: _omitted, ...unobserved } = f.plan.slices[0]!.acceptance[0]!;
  const plan = { ...f.plan, slices: [{ ...f.plan.slices[0]!, acceptance: [unobserved] }] };
  let prompt = '';
  const connector: Connector = async () => ({
    turn: async sent => {
      prompt = sent;
      return {
        status: 'completed',
        reply: { kind: 'message', text: JSON.stringify(plan), questions: [], findings: [] },
        usage: null,
        error: null,
      };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Verify the greeting' });
  const view = await kickoffs.send(id);
  assert.match(view.error!, /^Slice 1 acceptance: Acceptance requires expectedStdout or expectations/);
  assert.equal(view.candidate, null);
  // Exit status alone never accepts, so the planner is told both ways to state what acceptance observes.
  assert.match(prompt, /Every acceptance command states its observable result with expectedStdout or expectations/);
  assert.match(prompt, /expectations: \{stderr, stdoutJson, files/);
});

test('a revision request invalidates an older proposal even if its worker exits before turn claim', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  const connector: Connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
      usage: null,
      error: null,
    }),
    close: async () => {},
    interrupt: async () => {},
  });
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Verify greeting' });
  const ready = await kickoffs.send(id);
  assert.ok(ready.candidate);
  // Durable boundary reached by send() before runSession can claim a provider turn.
  store.appendSession(id, 'kickoff.message', { role: 'user', text: 'Change the acceptance examples' });
  store.appendSession(id, 'kickoff.error', { error: null });
  assert.equal(kickoffs.view(id).candidate, null);
  assert.throws(() => kickoffs.prepare(id, ready.candidateDigest!), /questions\/errors/);
  assert.equal(store.list().length, 0);
});

test('an explicit continuation after first-turn connection failure resupplies pinned files and the planning protocol', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  let connections = 0,
    supplied = '';
  const connector: Connector = async () => {
    if (++connections === 1) throw new Error('Offline first-connection failure');
    return {
      turn: async prompt => {
        supplied = prompt;
        return {
          status: 'completed',
          reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
          usage: null,
          error: null,
        };
      },
      close: async () => {},
      interrupt: async () => {},
    };
  };
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Verify greeting', contextFiles: ['greeting.js'] });
  const failed = await kickoffs.send(id);
  assert.match(failed.error!, /first-connection failure/);
  assert.equal(connections, 1);
  assert.equal(failed.candidate, null);
  const continued = await kickoffs.send(id, 'Try planning again with the original requirements');
  assert.equal(connections, 2);
  assert.equal(continued.error, null);
  assert.ok(continued.candidate);
  assert.match(supplied, /Pinned repository/);
  assert.match(supplied, /console.log\('hello'\)/);
  assert.match(supplied, /JSON guided plan/);
  assert.match(supplied, /Try planning again/);
});

test(
  'a reopened dashboard observes the original live worker, refuses takeover and can stop its real check',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t),
      db = join(f.root, 'grampus.sqlite');
    f.plan.slices[0]!.validation.args = ['-e', 'setInterval(() => {}, 1000)'];
    let ui = await startUi({ db, port: 0 });
    t.after(async () => {
      await ui.close();
      f.cleanup();
    });
    const { id } = await (await connect(ui).post('/api/tasks', { plan: f.plan })).json();
    // The controller's own records: the HTTP views show presentation, these show processes.
    const internal = () => ({
      state: new GuidedTasks(ui.store).get(id),
      checks: ui.store
        .executions()
        .filter(execution => execution.taskId === id)
        .flatMap(execution => ui.store.checks(execution.id)),
    });
    const until = async (predicate: (current: ReturnType<typeof internal>) => unknown) => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const current = internal();
        if (predicate(current)) return current;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Expected persisted checkpoint was not reached');
    };
    let api = connect(ui);
    await api.act(offered(await api.task(id), 'approve'));
    await api.act(offered(await api.task(id), 'run'));
    await until(current => current.state.status === 'awaiting_scope');
    // Let the preparation worker exit before authorizing through the same server.
    await settled(ui, id);
    await api.act(offered(await api.task(id), 'authorize'));
    let current = await until(current => current.checks[0]?.phase === 'running' && current.checks[0]?.toolPid);
    const owner = current.state.owner!,
      checkId = current.checks[0]!.id;
    assert.notEqual(owner.controllerPid, process.pid);
    await assert.rejects(ui.close(), /still running/);
    // Close only the HTTP/store surface. The actual controller runs in a separate process.
    await new Promise<void>(resolve => ui.server.close(() => resolve()));
    ui.store.close();
    ui = await startUi({ db, port: 0 });
    api = connect(ui);
    const view = await api.task(id);
    assert.equal(view.header.status, 'working', 'a controller started elsewhere is still working');
    assert.deepEqual(internal().state.owner, owner);
    assert.equal(view.results.checks.length, 1);
    assert.equal((await api.act(offered(view, 'recover'))).status, 202);
    assert.match((await settled(ui, id, 15_000))?.error ?? '', /still alive/);
    assert.equal((await api.act(offered(await api.task(id), 'stop'))).status, 200);
    current = await until(current => current.state.owner === null);
    assert.equal(current.state.status, 'blocked');
    assert.equal(current.checks.length, 1);
    assert.equal(current.checks[0]!.id, checkId);
    assert.equal(current.checks[0]!.phase, 'interrupted');
    assert.equal((await api.task(id)).results.commits.length, 0);
  },
);

test('planner answers bind the displayed turn even when later questions reuse the same id', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    f.cleanup();
  });
  let turns = 0;
  const connector: Connector = async () => {
    return {
      turn: async () => ({
        status: 'completed',
        reply: {
          kind: 'question',
          text: 'Clarify the example',
          questions: [
            {
              id: 'example',
              prompt: ++turns === 1 ? 'Which greeting?' : 'Should that greeting also apply to the edge case?',
              choices: [],
            },
          ],
          findings: [],
        },
        usage: null,
        error: null,
      }),
      close: async () => {},
      interrupt: async () => {},
    };
  };
  const planners = new Kickoffs(store, connector),
    id = planners.create({ repo: f.repo, request: 'Update greeting' });
  const first = await planners.send(id);
  const second = await planners.send(id, undefined, { example: 'hello' }, undefined, first.turnKey);
  assert.notEqual(first.turnKey, second.turnKey);
  assert.equal(turns, 2);
  const count = store.sessionEvents(id).length;
  await assert.rejects(planners.send(id, undefined, { example: 'stale answer' }, undefined, first.turnKey), /changed/);
  assert.equal(turns, 2);
  assert.equal(store.sessionEvents(id).length, count);
});
