// Slice tests: recovery and refusal to advance a slice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activeCriteria } from '../src/domain/workflow.js';
import type { Delivery } from '../src/execution/deliveries.js';
import { windows, git, invoke, fixture, type Fixture } from './helpers/slices.js';

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
  for (const kind of ['validation', 'quality', 'review', 'verification'] as const)
    f.workflow.record(f.task.id, {
      id: `${execution.id}:${kind}`,
      kind,
      ...(kind === 'quality' ? { pass: 'simplification' } : {}),
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

function crash(f: Fixture, spec: unknown): Delivery {
  const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {Store} from ${url('persistence/store')}; import {Deliveries} from ${url('execution/deliveries')}; import {runCheckProcess} from ${url('process/check-process')};
    await new Deliveries(new Store(${JSON.stringify(f.db)})).run(${JSON.stringify(f.execution.id)},${JSON.stringify(spec)},undefined,
      async options => { await runCheckProcess(options); process.exit(0); });`,
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  return f.store.deliveries(f.execution.id).at(-1)!;
}

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
