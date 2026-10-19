// Slice tests: approval and sequential delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/persistence/store.js';
import { Workflow, activeCriteria, activeSlice, type Brief } from '../src/domain/workflow.js';
import type { Execution } from '../src/execution/execution-state.js';
import { Sessions, runSession } from '../src/execution/sessions.js';
import type { Delivery } from '../src/execution/deliveries.js';
import { renderReport } from '../src/reporting/report.js';
import { windows, brief, git, invoke, fixture, type Fixture } from './helpers/slices.js';

const { slices: _slices, ...singleBrief } = brief;

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
  await f.checks.assess(execution.id, {
    pass: 'simplification',
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

test('ordered slices are version-approved, bounded and cover distinct known criteria', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-slice-plan-'));
  const store = new Store(join(root, 'grampus.sqlite'));
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
