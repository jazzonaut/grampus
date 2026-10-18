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

const windows = { skip: process.platform !== 'win32' };
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const message: Reply = { kind: 'message', text: 'Offline fixture implementation', questions: [], findings: [] };
const review: Reply = { kind: 'review', text: 'Offline fixture review', questions: [], findings: [] };
function git(cwd: string, ...args: string[]): string { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim(); }
function services(source = "console.log('hello world');\n", reply: Reply = message): GuidedServices {
  return {
    implementationRunner: options => runCheckProcess({ ...options, args: ['-e', `
      const fs = require('node:fs'); fs.writeFileSync('greeting.js', ${JSON.stringify(source)});
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},
        result:{status:'completed',reply:${JSON.stringify(reply)},usage:null,error:null}}));
    `] }),
    connector: async (_, options) => ({
      turn: async () => {
        options.emit({ type: 'session.connected', data: { providerSessionId: 'offline-guided-review', model: 'fixture' } });
        return { status: 'completed', reply: review, usage: null, error: null };
      }, interrupt: async () => {}, close: async () => {},
    }),
  };
}
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-guided-')), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n"); writeFileSync(join(repo, 'AGENTS.md'), 'Use one direct output statement.\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture baseline');
  const store = new Store(join(root, 'journal.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const plan = { brief: { title: 'Guided greeting', outcome: 'Print hello world', criteria: ['Print hello world with a newline'], plan: 'Edit, validate, simplify, review, verify and deliver locally' },
    workspace: { repo, path: join(root, 'workspace'), base: 'HEAD' }, implementation: { provider: 'codex' },
    slices: [{ scope: { files: ['greeting.js'] },
      validation: { file: 'node', args: ['-e', "const a=require('node:assert/strict');const {execFileSync}=require('node:child_process');a.equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n');console.log('validated');"], timeoutMs: 15000 },
      acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello world\n', timeoutMs: 15000 }, message: 'Implement guided greeting' }] };
  const tasks = new GuidedTasks(store, services());
  const create = () => { const task = tasks.create(plan); tasks.approve(task.id, 1, task.guided!.digest); return task.id; };
  return { root, repo, store, plan, tasks, create };
}

test('guided plan approval binds the complete recipe and CLI setup reaches a scope checkpoint without inference', windows, async t => {
  const f = fixture(t), file = join(f.root, 'plan.json'); writeFileSync(file, JSON.stringify(f.plan));
  const invoke = (...args: string[]) => execFileSync(process.execPath, [cli, '--db', f.store.path, '--json', ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  const created = JSON.parse(invoke('task-new', file)) as ReturnType<typeof guidedTaskView>;
  assert.equal(created.state.status, 'draft'); assert.equal(created.state.plan.workspace.base, git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(created.state.plan.slices[0]!.validation.file, process.execPath);
  assert.equal(f.store.workspaces().length, 0); assert.equal(f.store.sessions().length, 0);
  assert.throws(() => invoke('task-approve', created.task.id, '1', 'wrong'));
  await assert.rejects(f.tasks.run(created.task.id), /Approve/);
  invoke('task-approve', created.task.id, '1', created.state.digest);
  const prepared = JSON.parse(invoke('task-run', created.task.id)) as ReturnType<typeof guidedTaskView>;
  assert.equal(prepared.state.status, 'awaiting_scope'); assert.equal(prepared.implementations.length, 0);
  assert.equal(prepared.workspace!.baseCommit, created.state.plan.workspace.base);
  assert.match(renderGuidedTask(f.store, created.task.id, true), /Use one direct output statement/);
  assert.match(prepared.next, /task-authorize/); assert.equal(prepared.state.owner, null);
  await assert.rejects(f.tasks.run(created.task.id), /awaiting_scope/);
});

test('guided task connects real gates and a verified local commit across controller restarts', windows, async t => {
  const f = fixture(t), id = f.create();
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
    const done = await tasks.assess(id, 'passed', 'One direct statement follows the repository rule; no unnecessary abstractions.');
    assert.equal(done.status, 'complete', done.note); assert.equal(done.owner, null);
    const view = guidedTaskView(second, id);
    assert.equal(view.task.phase, 'complete'); assert.equal(view.deliveries.length, 1);
    assert.equal(view.deliveries[0]!.phase, 'delivered');
    assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD^'), done.plan.workspace.base);
    assert.equal(git(view.workspace!.path!, 'status', '--porcelain'), '');
    assert.match(renderReport(second, id), /guided.scope_authorized/);
    const turns = second.sessions().length;
    await assert.rejects(tasks.run(id), /complete/);
    await assert.rejects(tasks.assess(id, 'passed', 'repeat'), /No simplification/);
    assert.equal(second.sessions().length, turns);
  } finally { second.close(); }
});

test('failed simplification is retained and cannot start independent review or delivery', windows, async t => {
  const f = fixture(t), id = f.create(); await f.tasks.run(id);
  const checkpoint = await f.tasks.authorize(id); assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const failed = await f.tasks.assess(id, 'skipped', 'Inspection still outstanding');
  assert.equal(failed.status, 'blocked', failed.note);
  assert.ok(new Workflow(f.store).get(id).evidence.some(item => item.kind === 'simplification' && item.outcome === 'skipped'));
  assert.equal(f.store.executions<import('../src/execution-state.js').Execution>().filter(item => item.role === 'review').length, 0);
  assert.equal(f.store.deliveries(failed.executionId!).length, 0);
  await assert.rejects(f.tasks.run(id), /blocked/);
});

test('guided delivery verifies a larger repository while supplying only selected text context', windows, async t => {
  const f = fixture(t), asset = Buffer.alloc(1024 * 1024, 255);
  writeFileSync(join(f.repo, 'asset.bin'), asset); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'Existing binary asset');
  const plan = { ...f.plan, context: { files: ['greeting.js'] } };
  let reviewed = false;
  const configured = services();
  configured.connector = async () => ({ turn: async prompt => {
    assert.match(prompt, /"omittedFiles":1/); assert.match(prompt, /NOT reviewed/); reviewed = true;
    return { status: 'completed', reply: review, usage: null, error: null };
  }, close: async () => {}, interrupt: async () => {} });
  const tasks = new GuidedTasks(f.store, configured), task = tasks.create(plan);
  tasks.approve(task.id, 1, task.guided!.digest); await tasks.run(task.id);
  const checkpoint = await tasks.authorize(task.id); assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const done = await tasks.assess(task.id, 'passed', 'One direct output statement, inspected with the existing repository instructions.');
  assert.equal(done.status, 'complete', done.note); assert.equal(reviewed, true);
  const view = guidedTaskView(f.store, task.id);
  assert.deepEqual(readFileSync(join(view.workspace!.path!, 'asset.bin')), asset);
  assert.equal(git(view.workspace!.path!, 'status', '--porcelain'), '');
  assert.match(renderReport(f.store, task.id), /omittedFiles/);
});

test('stale scopes stop before dispatch while repository size is independent of selected context', windows, async t => {
  const f = fixture(t); let calls = 0;
  const tasks = new GuidedTasks(f.store, { ...services(), implementationRunner: async () => { calls++; throw new Error('Unexpected dispatch'); } });
  const id = f.create(); await tasks.run(id);
  const state = tasks.get(id), workspace = f.store.workspace<import('../src/workspaces.js').Workspace>(state.workspaceId!);
  writeFileSync(join(workspace.path!, 'greeting.js'), "console.log('external change');\n");
  const stopped = await tasks.authorize(id);
  assert.equal(stopped.status, 'blocked', stopped.note); assert.equal(calls, 0);
  writeFileSync(join(f.repo, 'large.txt'), 'x'.repeat(256 * 1024)); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'Too large for guided review');
  const larger = tasks.create({ ...f.plan, context: { files: ['greeting.js'] }, workspace: { ...f.plan.workspace, path: join(f.root, 'another-workspace') } });
  assert.ok(larger.guided!.plan.context!.totalBytes > 256 * 1024);
  assert.deepEqual(larger.guided!.plan.context!.files, ['AGENTS.md', 'greeting.js']);
});

test('blocking review stops delivery and explicit retry uses fresh sessions with preserved files', windows, async t => {
  const f = fixture(t); let reviews = 0;
  const config = services();
  config.connector = async (_, options) => ({
    turn: async prompt => {
      assert.match(prompt, /repository/i); reviews++;
      options.emit({ type: 'session.connected', data: { providerSessionId: `review-${reviews}`, model: 'fixture' } });
      return { status: 'completed', reply: reviews === 1 ? { ...review, findings: [{ severity: 'blocking', description: 'Fixture requests a repair review', evidence: 'Concrete offline finding' }] } : review, usage: null, error: null };
    }, interrupt: async () => {}, close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config), id = f.create();
  await tasks.run(id); await tasks.authorize(id);
  const failed = await tasks.assess(id, 'passed', 'One direct statement with no duplication');
  assert.equal(failed.status, 'blocked', failed.note); assert.equal(reviews, 1); assert.equal(f.store.deliveries(failed.executionId!).length, 0);
  const previous = f.store.execution<import('../src/execution-state.js').Execution>(failed.executionId!);
  const next = await tasks.retry(id);
  assert.equal(next.status, 'awaiting_scope', next.note);
  assert.notEqual(next.executionId, failed.executionId);
  assert.notEqual(f.store.execution<import('../src/execution-state.js').Execution>(next.executionId!).sessionId, previous.sessionId);
  const workspace = f.store.workspace<import('../src/workspaces.js').Workspace>(next.workspaceId!);
  assert.equal(readFileSync(join(workspace.path!, 'greeting.js'), 'utf8'), "console.log('hello world');\n");
  assert.match(next.feedback, /Concrete offline finding/);
  const repaired = await tasks.authorize(id);
  assert.equal(repaired.status, 'awaiting_assessment', repaired.note);
  const done = await tasks.assess(id, 'passed', 'Reviewed the retained implementation and fresh validation again');
  assert.equal(done.status, 'complete', done.note); assert.equal(reviews, 2);
  assert.equal(new Workflow(f.store).get(id).approvedVersion, 1);
});

test('review questions persist and an explicit answer resumes the same independent session', windows, async t => {
  const f = fixture(t); let turns = 0;
  const tasks = new GuidedTasks(f.store, { ...services(), connector: async (_, options) => ({
    turn: async prompt => {
      turns++;
      if (turns === 2) { assert.equal(options.providerSessionId, 'question-review'); assert.match(prompt, /yes, this is the intended output/); }
      options.emit({ type: 'session.connected', data: { providerSessionId: 'question-review', model: 'fixture' } });
      return { status: 'completed', reply: turns <= 2 ? { kind: 'question', text: 'Clarify one point', questions: [{ id: 'output', prompt: turns === 1 ? 'Is this output intended?' : 'Confirm the output also applies to the final example?', choices: ['yes'] }], findings: [] } : review, usage: null, error: null };
    }, interrupt: async () => {}, close: async () => {},
  }) });
  const id = f.create(); await tasks.run(id); await tasks.authorize(id);
  const questioned = await tasks.assess(id, 'passed', 'Inspected one direct statement');
  assert.equal(questioned.status, 'awaiting_answer', questioned.note);
  assert.equal(guidedTaskView(f.store, id).questions[0]!.id, 'output');
  await assert.rejects(tasks.answer(id, {}), /every pending/);
  await assert.rejects(tasks.run(id), /awaiting_answer/); assert.equal(turns, 1);
  const firstView = guidedTaskView(f.store, id), staleKey = guidedDecisionKey(firstView.state, firstView.questionKey);
  const secondQuestion = await tasks.answer(id, { output: 'yes, this is the intended output' });
  assert.equal(secondQuestion.status, 'awaiting_answer'); assert.equal(turns, 2);
  const secondView = guidedTaskView(f.store, id);
  assert.notEqual(guidedDecisionKey(secondView.state, secondView.questionKey), staleKey);
  await assert.rejects(new GuidedTasks(f.store, { expectedState: staleKey }).answer(id, { output: 'stale answer' }), /changed/);
  assert.equal(turns, 2);
  const done = await tasks.answer(id, { output: 'yes, including the final example' });
  assert.equal(done.status, 'complete', done.note); assert.equal(turns, 3); assert.equal(done.reviewId, questioned.reviewId);
});

test('no-change workflow runs every gate without implementation inference or a commit', windows, async t => {
  const f = fixture(t);
  const plan = structuredClone(f.plan);
  plan.brief.outcome = 'Confirm the existing hello greeting'; plan.brief.criteria = ['Print hello with a newline'];
  plan.slices[0]!.validation.args = ['greeting.js']; plan.slices[0]!.acceptance.expectedStdout = 'hello\n';
  const input = { ...plan, slices: [{ ...plan.slices[0]!, scope: { files: [] }, mode: 'no_change' }] };
  const tasks = new GuidedTasks(f.store, { ...services(), implementationRunner: async () => { throw new Error('No-change cannot call implementation'); } });
  const task = tasks.create(input); tasks.approve(task.id, 1, task.guided!.digest);
  await tasks.run(task.id); const checkpoint = await tasks.authorize(task.id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  assert.equal(f.store.implementations(checkpoint.executionId!).length, 0);
  const done = await tasks.assess(task.id, 'passed', 'Existing fixture already uses one direct output statement');
  assert.equal(done.status, 'complete', done.note);
  const view = guidedTaskView(f.store, task.id);
  assert.equal(view.deliveries[0]!.outcome, 'no_change'); assert.equal(view.deliveries[0]!.commit, null);
  assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD'), done.plan.workspace.base);
});

function crashProgram(f: ReturnType<typeof fixture>, action: 'authorize' | 'assess', nextStage: string, id: string, journalFailure = false): void {
  const file = join(f.root, `crash-${nextStage}.mjs`);
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  writeFileSync(file, `
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
  `);
  assert.throws(() => execFileSync(process.execPath, [file], { windowsHide: true, stdio: 'pipe' }), (error: unknown) => (error as { status: number }).status === 29);
}

test('a lost completed implementation is adopted without replay and continues only on explicit task-run', windows, async t => {
  const f = fixture(t), id = f.create(); await f.tasks.run(id);
  crashProgram(f, 'authorize', 'validation', id);
  const before = f.tasks.get(id); assert.equal(before.pending!.stage, 'implementation'); assert.ok(before.owner);
  const runs = f.store.implementations<ImplementationRun>(before.executionId!); assert.equal(runs.length, 1); assert.equal(runs[0]!.phase, 'completed');
  await assert.rejects(f.tasks.run(id), /running|uncertain/);
  const recovered = await f.tasks.recover(id);
  assert.equal(recovered.status, 'ready', recovered.note); assert.equal(recovered.stage, 'validation'); assert.equal(recovered.owner, null);
  assert.equal(f.store.implementations(before.executionId!).length, 1); assert.equal(f.store.checks(before.executionId!).length, 0);
  await assert.rejects(f.tasks.recover(id), /No guided recovery/);
  const checkpoint = await f.tasks.run(id); assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  const done = await f.tasks.assess(id, 'passed', 'Inspected preserved completed edit and real validation');
  assert.equal(done.status, 'complete', done.note); assert.equal(f.store.implementations(before.executionId!).length, 1);
});

for (const journalFailure of [false, true]) test(`a lost verified delivery after ${journalFailure ? 'journal failure' : 'controller exit'} is adopted once without inference or Git replay`, windows, async t => {
  const f = fixture(t), id = f.create(); await f.tasks.run(id); await f.tasks.authorize(id);
  crashProgram(f, 'assess', 'complete', id, journalFailure);
  const before = f.tasks.get(id); assert.equal(before.pending!.stage, 'delivery');
  const view = guidedTaskView(f.store, id), head = git(view.workspace!.path!, 'rev-parse', 'HEAD');
  assert.equal(view.task.phase, 'complete'); assert.equal(view.deliveries[0]!.phase, 'delivered');
  const sessions = f.store.sessions().length;
  const done = await f.tasks.recover(id);
  assert.equal(done.status, 'complete', done.note); assert.equal(done.owner, null);
  assert.equal(git(view.workspace!.path!, 'rev-parse', 'HEAD'), head); assert.equal(f.store.deliveries(before.executionId!).length, 1);
  assert.equal(f.store.sessions().length, sessions);
  await assert.rejects(f.tasks.recover(id), /No guided recovery/);
});

test('an explicit assessment entered before a controller exit remains bound and requires explicit continuation', windows, async t => {
  const f = fixture(t), id = f.create(); await f.tasks.run(id);
  const checkpoint = await f.tasks.authorize(id); assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  crashProgram(f, 'assess', 'assessment_input', id);
  const before = f.tasks.get(id); assert.equal(before.pending, null); assert.equal(before.assessment!.summary, 'Offline explicit simplification');
  const recovered = await f.tasks.recover(id);
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.stage, 'assessment'); assert.equal(recovered.reviewId, null);
  assert.equal(new Workflow(f.store).get(id).evidence.filter(item => item.kind === 'simplification' && item.outcome === 'passed').length, 0);
  const done = await f.tasks.run(id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(new Workflow(f.store).get(id).evidence.find(item => item.kind === 'simplification' && item.outcome === 'passed')!.summary, 'Offline explicit simplification');
});

test('one guided task owns execution and a cross-process stop request settles its actual tool', windows, async t => {
  const f = fixture(t), id = f.create();
  const other = f.tasks.create({ ...f.plan, workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') } });
  f.tasks.approve(other.id, 1, other.guided!.digest);
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const tasks = new GuidedTasks(f.store, { ...services(), implementationRunner: options => runCheckProcess({ ...options,
    args: ['-e', 'setInterval(() => {}, 1000)'], started: (kind, pid) => { options.started(kind, pid); if (kind === 'tool') started(); } }) });
  await tasks.run(id);
  const running = tasks.authorize(id); await entered;
  await assert.rejects(tasks.run(other.id), /Another guided task/);
  await assert.rejects(tasks.recover(id), /still alive/);
  execFileSync(process.execPath, [cli, '--db', f.store.path, 'task-stop', id], { windowsHide: true, stdio: 'pipe' });
  const stopped = await running;
  assert.equal(stopped.status, 'blocked', stopped.note); assert.equal(stopped.owner, null);
  assert.equal(f.store.implementations<ImplementationRun>(stopped.executionId!)[0]!.phase, 'interrupted');
  assert.equal(f.store.lease(stopped.workspaceId!), null);
  const prepared = await tasks.run(other.id); assert.equal(prepared.status, 'awaiting_scope', prepared.note);
});

test('unknown native shutdown retains global ownership and cannot admit another guided task', windows, async t => {
  const f = fixture(t), id = f.create();
  const other = f.tasks.create({ ...f.plan, workspace: { ...f.plan.workspace, path: join(f.root, 'other-workspace') } });
  f.tasks.approve(other.id, 1, other.guided!.digest);
  const tasks = new GuidedTasks(f.store, { implementationRunner: async () => ({ reason: 'supervisor_lost', exitCode: null,
    exitConfirmed: false, stdout: '', stderr: '', outputTruncated: false }) });
  await tasks.run(id); const uncertain = await tasks.authorize(id);
  assert.equal(uncertain.status, 'recovery_required'); assert.ok(uncertain.owner); assert.ok(uncertain.pending);
  assert.ok(f.store.lease(uncertain.workspaceId!));
  await assert.rejects(tasks.run(other.id), /Another guided task/);
  await assert.rejects(tasks.retry(id), /recover uncertain/);
  await assert.rejects(tasks.recover(id), /still alive/);
});

test('implementation questions require explicit answers and a fresh scope authorization before another turn', windows, async t => {
  const f = fixture(t); let calls = 0;
  const question: Reply = { kind: 'question', text: 'Confirm greeting', questions: [{ id: 'wording', prompt: 'Use hello world?', choices: ['yes'] }], findings: [] };
  const tasks = new GuidedTasks(f.store, { ...services(), implementationRunner: options => {
    calls++;
    const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as { prompt: string };
    if (calls === 2) assert.match(request.prompt, /yes, hello world/);
    return services(calls === 1 ? "console.log('partial');\n" : "console.log('hello world');\n", calls === 1 ? question : message).implementationRunner!(options);
  } });
  const id = f.create(); await tasks.run(id);
  const questioned = await tasks.authorize(id);
  assert.equal(questioned.status, 'awaiting_answer', questioned.note); assert.equal(calls, 1);
  const answered = await tasks.answer(id, { wording: 'yes, hello world' });
  assert.equal(answered.status, 'awaiting_scope', answered.note); assert.equal(calls, 1);
  assert.notEqual(answered.policy!.artifact, questioned.policy!.artifact);
  const checkpoint = await tasks.authorize(id); assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note); assert.equal(calls, 2);
  const done = await tasks.assess(id, 'passed', 'Inspected the final direct greeting statement after answering');
  assert.equal(done.status, 'complete', done.note);
});

test('planned ordered slices require separate assessments and final whole-task acceptance', windows, async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'cli.js'), "console.log('pending');\n"); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'CLI fixture baseline');
  const criteria = ['Library exposes hello world', 'CLI prints hello world with a newline'];
  const libraryCheck = "require('node:assert/strict').equal(require('./greeting.js'),'hello world');console.log('library ok');";
  const allCheck = libraryCheck + "require('node:assert/strict').equal(require('node:child_process').execFileSync(process.execPath,['cli.js'],{encoding:'utf8'}),'hello world\\n');console.log('cli ok');";
  const plan = { ...f.plan, brief: { ...f.plan.brief, criteria, slices: [
    { title: 'Library', plan: 'Expose the greeting', criteria: [criteria[0]!] }, { title: 'CLI integration', plan: 'Reuse the library and verify both', criteria: [criteria[1]!] },
  ] }, slices: [
    { scope: { files: ['greeting.js'] }, validation: { file: 'node', args: ['-e', libraryCheck], timeoutMs: 15000 },
      acceptance: { file: 'node', args: ['-e', libraryCheck], expectedStdout: 'library ok\n', timeoutMs: 15000 }, message: 'Expose greeting library' },
    { scope: { files: ['cli.js'] }, validation: { file: 'node', args: ['-e', allCheck], timeoutMs: 15000 },
      acceptance: { file: 'node', args: ['-e', allCheck], expectedStdout: 'library ok\ncli ok\n', timeoutMs: 15000 }, message: 'Integrate greeting CLI' },
  ] };
  const tasks = new GuidedTasks(f.store, { ...services(), implementationRunner: options => {
    const run = f.store.implementation<ImplementationRun>(options.receipt!.checkId);
    const file = run.policy.files[0]!, source = file === 'greeting.js' ? "module.exports = 'hello world';\n" : "console.log(require('./greeting.js'));\n";
    return runCheckProcess({ ...options, args: ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(source)});
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))},JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));`] });
  } });
  const kickoffs = new Kickoffs(f.store, async () => ({
    turn: async () => ({ status: 'completed', reply: { ...message, text: JSON.stringify(plan) }, usage: null, error: null }),
    interrupt: async () => {}, close: async () => {},
  }));
  const kickoffId = kickoffs.create({ repo: f.repo, request: 'Deliver the full greeting library and CLI task in sequential slices' });
  const proposal = await kickoffs.send(kickoffId); assert.equal(proposal.error, null);
  const id = kickoffs.prepare(kickoffId, proposal.candidateDigest!), draft = tasks.get(id);
  assert.equal(draft.status, 'draft'); assert.equal(draft.plan.slices.length, 2);
  tasks.approve(id, draft.version, draft.digest);
  await tasks.run(id); const first = await tasks.authorize(id); assert.equal(first.status, 'awaiting_assessment', first.note);
  const next = await tasks.assess(id, 'passed', 'One exported string; the CLI remains for the next slice');
  assert.equal(next.status, 'awaiting_scope', next.note); assert.equal(next.sliceIndex, 1); assert.notEqual(next.executionId, first.executionId);
  const firstDelivery = f.store.deliveries<import('../src/deliveries.js').Delivery>(first.executionId!)[0]!;
  const workspace = guidedTaskView(f.store, id).workspace!;
  const libraryBlob = git(workspace.path!, 'rev-parse', 'HEAD:greeting.js');
  await tasks.authorize(id);
  const done = await tasks.assess(id, 'passed', 'The CLI reuses the delivered library with one output statement');
  assert.equal(done.status, 'complete', done.note);
  assert.equal(git(workspace.path!, 'rev-parse', 'HEAD^'), firstDelivery.commit);
  assert.equal(git(workspace.path!, 'rev-parse', 'HEAD:greeting.js'), libraryBlob);
  assert.deepEqual(guidedTaskView(f.store, id).checks.at(-1)!.spec.criteria, criteria);
  assert.equal(new Workflow(f.store).get(id).slice!.completed.length, 2);
});

for (const gate of ['validation', 'acceptance'] as const) test(`a failing ${gate} command is retained and cannot reach delivery or replay itself`, windows, async t => {
  const f = fixture(t);
  if (gate === 'validation') f.plan.slices[0]!.validation.args = ['-e', 'process.exit(7)'];
  else f.plan.slices[0]!.acceptance.expectedStdout = 'unexpected output\n';
  const id = f.create(); await f.tasks.run(id);
  let result = await f.tasks.authorize(id);
  if (gate === 'acceptance') { assert.equal(result.status, 'awaiting_assessment', result.note); result = await f.tasks.assess(id, 'passed', 'Inspected the one direct statement'); }
  assert.equal(result.status, 'blocked', result.note); assert.equal(result.owner, null); assert.equal(f.store.deliveries(result.executionId!).length, 0);
  const view = guidedTaskView(f.store, id);
  assert.equal(view.checks.at(-1)!.phase, 'failed');
  if (gate === 'validation') assert.equal(view.checks.at(-1)!.result!.exitCode, 7);
  else assert.ok(view.task.evidence.some(item => item.kind === 'verification' && item.outcome === 'failed'));
  const attempts = f.store.implementations(result.executionId!).length, checks = view.checks.length;
  await assert.rejects(f.tasks.run(id), /blocked/);
  assert.equal(f.store.implementations(result.executionId!).length, attempts); assert.equal(f.store.checks(result.executionId!).length, checks);
});

test('recovery refuses a completed result with a different file authorization', windows, async t => {
  const f = fixture(t), id = f.create(); await f.tasks.run(id); crashProgram(f, 'authorize', 'validation', id);
  const before = f.tasks.get(id), run = f.store.implementations<ImplementationRun>(before.executionId!)[0]!;
  f.store.saveImplementation(run.id, run.executionId, { ...run, policy: { ...run.policy, files: ['AGENTS.md'] } });
  const refused = await f.tasks.recover(id);
  assert.equal(refused.status, 'recovery_required'); assert.match(refused.note, /differs from the authorized file policy/);
  assert.ok(refused.pending); assert.ok(refused.owner);
  assert.equal(f.store.checks(before.executionId!).length, 0); assert.equal(f.store.deliveries(before.executionId!).length, 0);
});
