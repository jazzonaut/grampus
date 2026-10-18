import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Workflow, activeCriteria, activeSlice, type Brief } from '../src/workflow.js';
import { Workspaces } from '../src/workspaces.js';
import { Executions } from '../src/executions.js';
import type { Execution } from '../src/execution-state.js';
import { Sessions, runSession } from '../src/sessions.js';
import { Checks } from '../src/checks.js';
import { Deliveries, type Delivery } from '../src/deliveries.js';
import { renderReport } from '../src/report.js';

const windows = { skip: process.platform !== 'win32' };
const brief: Brief = {
  title: 'Greeting library and CLI',
  outcome: 'Expose the greeting through a CLI',
  criteria: ['Library returns hello world', 'CLI prints hello world with a newline'],
  plan: 'Deliver the library, then the CLI and verify both together',
  slices: [
    { title: 'Library', plan: 'Update the library', criteria: ['Library returns hello world'] },
    { title: 'CLI', plan: 'Wire the CLI and inspect integration', criteria: ['CLI prints hello world with a newline'] },
  ],
};
const { slices: _slices, ...singleBrief } = brief;
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function invoke(db: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, '--db', db, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  });
}
async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-slices-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.cjs'), "module.exports = 'hello';\n");
  writeFileSync(join(repo, 'cli.cjs'), "console.log('pending');\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Baseline');
  const db = join(root, 'journal.sqlite');
  const store = new Store(db);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workflow = new Workflow(store);
  const task = workflow.create(brief);
  workflow.approve(task.id, 1);
  const workspaces = new Workspaces(store);
  const workspace = await workspaces.create(task.id, 1, repo, join(root, 'workspace'));
  const executions = new Executions(store);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const checks = new Checks(store);
  const deliveries = new Deliveries(store);
  return { root, repo, db, store, workflow, task, workspace, executions, execution, checks, deliveries };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function gated(f: Fixture, execution = f.execution) {
  const snapshot = await f.checks.snapshot(execution.id);
  f.workflow.finish(
    f.task.id,
    execution.attemptId,
    1,
    'succeeded',
    snapshot.artifact,
    'Trusted offline fixture submission',
  );
  for (const kind of ['validation', 'simplification', 'review', 'verification'] as const)
    f.workflow.record(f.task.id, {
      id: `${execution.id}:${kind}`,
      kind,
      artifact: snapshot.artifact,
      attemptId: execution.attemptId,
      version: 1,
      outcome: 'passed',
      source: 'controller',
      criteria: activeCriteria(f.workflow.get(f.task.id)),
      summary: 'Trusted fixture evidence, no live inference',
      ...(kind === 'review'
        ? { agent: { provider: 'claude', model: 'fixture', sessionId: `${execution.id}:review` } }
        : {}),
    });
  return {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    message: 'Deliver slice fixture',
    timeoutMs: 15000,
  };
}
async function verified(f: Fixture, execution: Execution, final: boolean) {
  const snapshot = await f.checks.snapshot(execution.id);
  const script =
    "const a=require('node:assert/strict'); a.equal(require('./greeting.cjs'),'hello world'); console.log('library ok');" +
    (final
      ? "const {execFileSync}=require('node:child_process'); a.equal(execFileSync(process.execPath,['cli.cjs'],{encoding:'utf8'}),'hello world\\n'); console.log('cli ok');"
      : '');
  const spec = {
    name: 'Greeting regression',
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    file: process.execPath,
    args: ['-e', script],
    timeoutMs: 15000,
  };
  const validation = await f.checks.run(execution.id, spec);
  assert.equal(validation.phase, 'passed', JSON.stringify(validation));
  await f.checks.finish(execution.id, validation.id);
  await f.checks.simplify(execution.id, {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    outcome: 'passed',
    summary: 'Fixture library exports one string; CLI reuses it without duplication',
  });
  const review = await f.executions.create(f.workspace.id, 1, 'claude', 'review');
  const reviewed = await runSession(
    f.store,
    review.sessionId,
    'Review the current slice',
    { artifactReview: true },
    async (_, options) => ({
      turn: async prompt => {
        assert.ok(prompt.includes(`"number":${final ? 2 : 1},"total":2,"final":${final}`));
        assert.ok(prompt.includes('current slice only'));
        if (final) assert.ok(prompt.includes(f.workflow.get(f.task.id).slice!.completed[0]!.head));
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: `fixture-${review.id}`, model: 'fixture-model' },
        });
        return {
          status: 'completed',
          reply: { kind: 'review', text: 'Offline fixture review', questions: [], findings: [] },
          usage: null,
          error: null,
        };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  );
  assert.equal(reviewed.status, 'completed', JSON.stringify(reviewed));
  if (final)
    await assert.rejects(
      f.checks.run(execution.id, {
        ...spec,
        criteria: brief.slices![1]!.criteria,
        expectedStdout: 'library ok\ncli ok\n',
      }),
      /exact mapping/,
    );
  const acceptance = await f.checks.run(execution.id, {
    ...spec,
    criteria: activeCriteria(f.workflow.get(f.task.id)),
    expectedStdout: final ? 'library ok\ncli ok\n' : 'library ok\n',
  });
  assert.equal(acceptance.phase, 'passed', JSON.stringify(acceptance));
  return {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    message: final ? 'Add greeting CLI' : 'Update greeting library',
    timeoutMs: 15000,
  };
}
function deliverCLI(f: Fixture, execution: Execution, spec: unknown): Delivery {
  const file = join(f.root, `${execution.id}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return JSON.parse(invoke(f.db, 'execution-deliver', execution.id, file)) as Delivery;
}
function crash(f: Fixture, spec: unknown): Delivery {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {Store} from ${url('store')}; import {Deliveries} from ${url('deliveries')}; import {runCheckProcess} from ${url('check-process')};
    await new Deliveries(new Store(${JSON.stringify(f.db)})).run(${JSON.stringify(f.execution.id)},${JSON.stringify(spec)},undefined,
      async options => { await runCheckProcess(options); process.exit(0); });`,
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  return f.store.deliveries<Delivery>(f.execution.id).at(-1)!;
}

test('ordered slices are version-approved, bounded and cover distinct known criteria', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-slice-plan-'));
  const store = new Store(join(root, 'journal.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workflow = new Workflow(store);
  for (const slices of [
    [],
    null,
    [null],
    [brief.slices![0]],
    [{ ...brief.slices![0], criteria: ['unknown'] }],
    [{ ...brief.slices![0], criteria: [brief.criteria[0], brief.criteria[0]] }],
    [{ ...brief.slices![0], title: ' ' }],
    Array(65).fill(brief.slices![0]),
  ]) {
    assert.throws(() => workflow.create({ ...brief, slices } as Brief));
  }
  const task = workflow.create(brief);
  workflow.approve(task.id, 1);
  assert.deepEqual(activeCriteria(task), [brief.criteria[0]]);
  assert.equal(activeSlice(task)?.number, 1);
  workflow.revise(task.id, 1, { ...brief, slices: [...brief.slices!].reverse() });
  assert.equal(workflow.get(task.id).approvedVersion, null);
  assert.throws(() => workflow.approve(task.id, 1), /outdated/);
  workflow.revise(task.id, 2, singleBrief);
  assert.equal(workflow.get(task.id).slice, undefined);
});

test(
  'two slices require fresh gates, separate commits and final integration checks across CLI restarts',
  windows,
  async t => {
    const f = await fixture(t);
    writeFileSync(join(f.workspace.path, 'greeting.cjs'), "module.exports = 'hello world';\n");
    const firstSpec = await verified(f, f.execution, false);
    assert.deepEqual(f.workflow.sliceBlockers(f.task.id), []);
    await assert.rejects(f.checks.complete(f.execution.id), /slices have not all been delivered/);
    const firstEvidence = f.workflow.get(f.task.id).evidence;
    const first = deliverCLI(f, f.execution, firstSpec);
    assert.equal(first.phase, 'delivered');
    const next = f.workflow.get(f.task.id);
    assert.equal(next.phase, 'ready');
    assert.equal(next.version, 1);
    assert.equal(next.approvedVersion, 1);
    assert.equal(next.slice!.index, 1);
    assert.equal(next.slice!.completed.length, 1);
    assert.equal(next.attempt, null);
    assert.deepEqual(next.evidence, []);
    assert.throws(
      () => new Sessions(f.store).claim(f.execution.sessionId, 'Old implementation'),
      /outdated task attempt/,
    );
    const oldReview = f.store.executions<Execution>().find(item => item.role === 'review')!;
    assert.throws(() => new Sessions(f.store).claim(oldReview.sessionId, 'Old review'), /outdated task attempt/);
    await assert.rejects(f.deliveries.run(f.execution.id, firstSpec), /every gate/);
    const second = JSON.parse(invoke(f.db, 'execution-new', f.workspace.id, '1', 'codex')) as Execution;
    assert.equal(second.headAtCreation, first.commit);
    assert.notEqual(second.attemptId, f.execution.attemptId);
    assert.equal(f.workflow.record(f.task.id, firstEvidence[0]!), false);
    assert.deepEqual(activeCriteria(f.workflow.get(f.task.id)), brief.criteria);
    writeFileSync(join(f.workspace.path, 'cli.cjs'), "console.log(require('./greeting.cjs'));\n");
    const secondSpec = await verified(f, second, true);
    await assert.rejects(f.checks.complete(second.id), /slices have not all been delivered/);
    const last = deliverCLI(f, second, secondSpec);
    assert.equal(last.phase, 'delivered');
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD^'), first.commit);
    assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '3');
    assert.equal(f.workflow.get(f.task.id).phase, 'complete');
    assert.deepEqual(f.workflow.blockers(f.task.id), []);
    assert.equal(f.workflow.get(f.task.id).slice!.completed.length, 2);
    assert.equal(f.store.events(f.task.id).filter(event => event.type === 'task.completed').length, 1);
    assert.match(renderReport(f.store, f.task.id), /Delivered: 2\/2/);
    assert.equal(f.workspace.baseCommit, git(f.workspace.path, 'rev-parse', 'HEAD~2'));
  },
);

test(
  'receipt recovery advances a slice exactly once after a real controller exit, including no-change',
  windows,
  async t => {
    for (const mode of ['commit', 'no_change'] as const) {
      const f = await fixture(t);
      if (mode === 'commit') writeFileSync(join(f.workspace.path, 'greeting.cjs'), "module.exports = 'hello world';\n");
      const spec = { ...(await gated(f)), mode };
      const pending = crash(f, spec);
      assert.equal(f.workflow.get(f.task.id).slice!.completed.length, 0);
      assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
      await assert.rejects(f.executions.create(f.workspace.id, 1, 'codex'), /execution lease/);
      const head = git(f.workspace.path, 'rev-parse', 'HEAD');
      const recovered = JSON.parse(invoke(f.db, 'delivery-recover', pending.id)) as Delivery;
      assert.equal(recovered.phase, 'delivered', JSON.stringify(recovered));
      assert.equal(f.workflow.get(f.task.id).phase, 'ready');
      assert.equal(f.workflow.get(f.task.id).slice!.completed[0]!.head, head);
      assert.equal(
        f.workflow.get(f.task.id).slice!.completed[0]!.outcome,
        mode === 'commit' ? 'committed' : 'no_change',
      );
      await assert.rejects(f.deliveries.recover(pending.id), /does not need recovery/);
      assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), head);
      assert.equal(f.store.events(f.task.id).filter(event => event.type === 'slice.delivered').length, 1);
      const next = await f.executions.create(f.workspace.id, 1, 'codex');
      f.executions.close(next.id);
      const retry = await f.executions.create(f.workspace.id, 1, 'codex');
      assert.notEqual(retry.attemptId, next.attemptId);
      assert.equal(f.workflow.get(f.task.id).slice!.index, 1);
      assert.equal(f.workflow.get(f.task.id).slice!.completed.length, 1);
    }
  },
);

test('failed delivery, pending decisions and journal rollback cannot advance a slice', windows, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace.path, 'greeting.cjs'), "module.exports = 'hello world';\n");
  const spec = await gated(f);
  const decision = f.workflow.addDecision(f.task.id, 'Fixture scope decision');
  await assert.rejects(f.deliveries.run(f.execution.id, spec), /Provisional decisions/);
  f.workflow.acceptDecision(f.task.id, decision, 1);
  const failed = await f.deliveries.run(f.execution.id, spec, undefined, async () => ({
    reason: 'exited',
    exitCode: 1,
    exitConfirmed: true,
    stdout: '',
    stderr: 'Fixture failure',
    outputTruncated: false,
  }));
  assert.equal(failed.phase, 'failed');
  assert.equal(f.workflow.get(f.task.id).slice!.index, 0);
  const append = f.store.append.bind(f.store);
  let fail = true;
  f.store.append = (id, version, type, data) => {
    if (type === 'slice.ready' && fail) {
      fail = false;
      throw new Error('Injected continuation journal failure');
    }
    append(id, version, type, data);
  };
  const rolledBack = await f.deliveries.run(f.execution.id, spec);
  assert.equal(rolledBack.phase, 'failed');
  assert.match(rolledBack.error!, /journal failure/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.deepEqual(f.workflow.get(f.task.id).slice!.completed, []);
  assert.equal(f.workflow.get(f.task.id).attempt!.id, f.execution.attemptId);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.ok(
    !f.store.events(f.task.id).some(event => ['slice.delivered', 'slice.ready', 'task.completed'].includes(event.type)),
  );
  assert.notEqual(git(f.workspace.path, 'rev-parse', 'HEAD'), f.workspace.baseCommit); // Unaccepted commit remains for investigation.
});

test(
  'continuation refuses changed raw files, index, instructions and HEAD without creating sessions',
  windows,
  async t => {
    const f = await fixture(t);
    writeFileSync(join(f.workspace.path, 'greeting.cjs'), "module.exports = 'hello world';\n");
    const delivery = await f.deliveries.run(f.execution.id, await gated(f));
    assert.equal(delivery.phase, 'delivered');
    const sessions = f.store.sessions().length;
    git(f.workspace.path, 'update-index', '--skip-worktree', 'cli.cjs');
    writeFileSync(join(f.workspace.path, 'cli.cjs'), "console.log('unreviewed');\n");
    assert.equal(git(f.workspace.path, 'status', '--porcelain'), ''); // Raw equality must catch this.
    await assert.rejects(f.executions.create(f.workspace.id, 1, 'codex'), /bytes differ/);
    writeFileSync(join(f.workspace.path, 'cli.cjs'), "console.log('pending');\n");
    git(f.workspace.path, 'update-index', '--no-skip-worktree', 'cli.cjs');
    git(f.workspace.path, 'update-index', '--chmod=+x', 'cli.cjs');
    await assert.rejects(f.executions.create(f.workspace.id, 1, 'codex'), /mode differs/);
    git(f.workspace.path, 'update-index', '--chmod=-x', 'cli.cjs');
    writeFileSync(join(f.root, 'AGENTS.md'), 'Changed inherited instructions\n');
    await assert.rejects(f.executions.create(f.workspace.id, 1, 'codex'), /unchanged instructions/);
    rmSync(join(f.root, 'AGENTS.md'));
    git(f.workspace.path, 'commit', '--allow-empty', '-m', 'External commit');
    await assert.rejects(f.executions.create(f.workspace.id, 1, 'codex'), /HEAD differs/);
    assert.equal(f.store.sessions().length, sessions);
    assert.equal(f.workflow.get(f.task.id).phase, 'ready');
  },
);

test('schema 9 migration preserves single-slice state and history and fences older executables', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-slice-migrate-'));
  const path = join(root, 'journal.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path);
  const workflow = new Workflow(store);
  const task = workflow.create(singleBrief);
  workflow.approve(task.id, 1);
  const before = workflow.get(task.id);
  const events = store.events(task.id);
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA user_version = 9');
  legacy.close();
  const migrated = new Store(path);
  try {
    assert.deepEqual(new Workflow(migrated).get(task.id), before);
    assert.deepEqual(migrated.events(task.id), events);
  } finally {
    migrated.close();
  }
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 10);
  } finally {
    db.close();
  }
});
