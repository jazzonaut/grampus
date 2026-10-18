// Orca tests: supervised delivery, slices and identity checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { Executions } from '../src/executions.js';
import { deliverRepository } from '../src/delivery-operation.js';
import type { DeliveryRequest } from '../src/delivery-git.js';
import { brief, git, windows, deliveryFixture, supervisedOrcaWriter } from './helpers/orca.js';

test(
  'Orca delivery runs the supervised Git writer, preserves identity and completes exact checked content',
  windows,
  async t => {
    const f = await deliveryFixture(t);
    const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, options =>
      supervisedOrcaWriter(f, options),
    );
    assert.equal(delivery.phase, 'delivered', JSON.stringify(delivery));
    assert.equal(delivery.request?.orca?.identityKey, f.workspace.orca!.identityKey);
    assert.equal(
      git(f.workspace.path, 'show', '-s', '--format=%an <%ae> / %cn <%ce>'),
      'Fixture <fixture@invalid> / Fixture <fixture@invalid>',
    );
    assert.equal(git(f.workspace.path, 'status', '--porcelain'), '');
    assert.equal(f.workflow.get(f.task.id).phase, 'complete');
    assert.equal(f.store.lease(f.workspace.id), null);
  },
);

test('Orca slices reuse the original instance and base, with identity checks before continuation', windows, async t => {
  const slice = { title: 'First', plan: 'Deliver fixture greeting', criteria: brief.criteria };
  const f = await deliveryFixture(t, false, { ...brief, slices: [slice, { ...slice, title: 'Integration' }] });
  const first = await f.deliveries.run(f.execution.id, f.spec, undefined, options => supervisedOrcaWriter(f, options));
  assert.equal(first.phase, 'delivered', JSON.stringify(first));
  assert.equal(f.workflow.get(f.task.id).phase, 'ready');
  assert.equal(f.workflow.get(f.task.id).slice!.completed.length, 1);
  const executions = new Executions(f.store, f.workspaces);
  f.state.worktree!.isArchived = true;
  await assert.rejects(executions.create(f.workspace.id, 1, 'codex'), /changed/);
  f.state.worktree!.isArchived = false;
  const next = await executions.create(f.workspace.id, 1, 'codex');
  assert.equal(next.headAtCreation, first.commit);
  const snapshot = await f.checks.snapshot(next.id);
  f.workflow.finish(
    f.task.id,
    next.attemptId,
    1,
    'succeeded',
    snapshot.artifact,
    'Trusted final integration fixture submission',
  );
  for (const kind of ['validation', 'simplification', 'review', 'verification'] as const)
    f.workflow.record(f.task.id, {
      id: `${next.id}:${kind}`,
      kind,
      artifact: snapshot.artifact,
      version: 1,
      attemptId: next.attemptId,
      outcome: 'passed',
      source: 'controller',
      summary: 'Offline integration fixture gates; no live inference',
      criteria: brief.criteria,
      ...(kind === 'review'
        ? { agent: { provider: 'claude', model: 'fixture', sessionId: 'final-fixture-review' } }
        : {}),
    });
  const last = await f.deliveries.run(
    next.id,
    { ...f.spec, artifact: snapshot.artifact, mode: 'no_change' },
    undefined,
    options => supervisedOrcaWriter(f, options),
  );
  assert.equal(last.phase, 'delivered', JSON.stringify(last));
  assert.equal(last.outcome, 'no_change');
  assert.equal(f.workflow.get(f.task.id).phase, 'complete');
  assert.equal(f.workspaces.get(f.workspace.id).baseCommit, f.workspace.baseCommit);
  assert.equal(f.workspaces.get(f.workspace.id).orca!.identityKey, f.workspace.orca!.identityKey);
  assert.equal(git(f.workspace.path, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(f.requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
});

test('Orca delivery worker rechecks ownership before staging and before commit', windows, async t => {
  for (const changeAt of [1, 3]) {
    const f = await deliveryFixture(t);
    let observations = 0;
    const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
      const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as DeliveryRequest;
      await assert.rejects(
        deliverRepository(request, join(f.root, 'message'), store => {
          const workspaces = new Workspaces(store, f.client);
          const inspect = workspaces.inspect.bind(workspaces);
          workspaces.inspect = async (...args) => {
            if (++observations === changeAt) f.state.worktree!.isArchived = true;
            return inspect(...args);
          };
          return workspaces;
        }),
        /changed/,
      );
      return {
        reason: 'exited',
        exitCode: 1,
        exitConfirmed: true,
        stdout: '',
        stderr: 'Fixture identity changed',
        outputTruncated: false,
      };
    });
    assert.equal(delivery.phase, 'failed');
    assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
    assert.equal(git(f.workspace.path, 'diff', '--cached', '--name-only'), changeAt === 1 ? '' : 'greeting.txt');
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  }
});

test('Orca writer rejects a request that differs from the durable delivery binding', windows, async t => {
  const f = await deliveryFixture(t);
  const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
    const request = JSON.parse(readFileSync(options.args[1]!, 'utf8')) as DeliveryRequest;
    request.orca!.identityKey = 'wt2:local:replacement';
    await assert.rejects(
      deliverRepository(request, join(f.root, 'message'), store => new Workspaces(store, f.client)),
      /no longer owns/,
    );
    return { reason: 'exited', exitCode: 1, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  });
  assert.equal(delivery.phase, 'failed');
  assert.equal(git(f.workspace.path, 'diff', '--cached', '--name-only'), '');
});

test('Orca identity replacement after a confirmed commit cannot complete the task', windows, async t => {
  const f = await deliveryFixture(t);
  const delivery = await f.deliveries.run(f.execution.id, f.spec, undefined, async options => {
    const result = await supervisedOrcaWriter(f, options);
    f.state.worktree!.isArchived = true;
    return result;
  });
  assert.equal(delivery.phase, 'failed');
  assert.equal(delivery.commit, null);
  assert.notEqual(git(f.workspace.path, 'rev-parse', 'HEAD'), f.snapshot.head);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  assert.equal(f.store.lease(f.workspace.id), null);
});
