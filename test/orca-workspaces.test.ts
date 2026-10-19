// Orca tests: workspace creation, discovery, recovery, execution and editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { Workspaces } from '../src/repository/workspaces.js';
import { OrcaCli } from '../src/repository/orca.js';
import { Executions } from '../src/execution/executions.js';
import { runSession } from '../src/execution/sessions.js';
import type { Connector } from '../src/providers/types.js';
import { Sessions } from '../src/execution/sessions.js';
import type { CheckProcessOptions } from '../src/process/check-process.js';
import { git, fixture, windows, implementationFixture } from './helpers/orca.js';

function editedResult(options: CheckProcessOptions) {
  writeFileSync(join(options.cwd, 'greeting.txt'), 'hello world\n');
  writeFileSync(
    join(options.receipt!.directory, 'result.json'),
    JSON.stringify({
      id: options.receipt!.checkId,
      result: {
        status: 'completed',
        reply: { kind: 'message', text: 'Fixture edited greeting', questions: [], findings: [] },
        usage: null,
        error: null,
      },
    }),
  );
  return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
}

test('Orca creation pins the base without requesting agents or Orca setup hooks', async t => {
  const { repo, store, task, workspaces, requests } = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'greeting.txt'), 'preserve dirty source\n');
  const before = git(repo, 'status', '--porcelain');
  const created = await workspaces.createOrca(task.id, 1, repo, 'main');
  assert.equal(created.adapter, 'orca');
  assert.equal(created.phase, 'ready');
  assert.equal(created.owner, null);
  assert.equal(created.baseCommit, base);
  assert.ok(created.branch.startsWith('fixture/'));
  assert.equal(created.orca?.identityKey, 'wt2:local:instance-a');
  assert.equal(git(repo, 'status', '--porcelain'), before);
  const create = requests.find(args => args[1] === 'create' && !args.includes('--help'))!;
  assert.ok(create.includes('--no-parent'));
  assert.equal(create[create.indexOf('--setup') + 1], 'skip');
  assert.equal(create[create.indexOf('--base-branch') + 1], base);
  assert.ok(!create.includes('--agent') && !create.includes('--activate') && !create.includes('--path'));
  assert.deepEqual(
    store.workspaceEvents(created.id).map(event => event.type),
    ['workspace.requested', 'orca.identity_recorded', 'workspace.ready'],
  );
  assert.equal((await workspaces.inspect(created.id)).dirty, false);
});

test('a lost Orca reply is discovered after reopening without a second create request', async t => {
  const { repo, db, store, task, workspaces, client, state, requests } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'), /must not be replayed/);
  const unknown = workspaces.list()[0]!;
  assert.equal(unknown.phase, 'recovery_required');
  assert.equal(unknown.path, null);
  assert.equal(unknown.orca?.identityKey, null);
  const reopened = new Store(db);
  try {
    const recovered = await new Workspaces(reopened, client).recover(unknown.id);
    assert.equal(recovered.phase, 'ready');
    assert.ok(recovered.path);
    assert.equal(recovered.orca?.identityKey, 'wt2:local:instance-a');
  } finally {
    reopened.close();
  }
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
  assert.deepEqual(store.workspaceEvents(unknown.id).at(-1)?.data, { replayed: false });
});

test('missing, duplicate and truncated Orca discovery results retain the reservation without replay', async t => {
  const { repo, task, workspaces, state, requests } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'));
  const id = workspaces.list()[0]!.id;
  state.empty = true;
  await assert.rejects(workspaces.recover(id), /unknown or ambiguous/);
  state.empty = false;
  state.duplicate = true;
  await assert.rejects(workspaces.recover(id), /unknown or ambiguous/);
  state.duplicate = false;
  state.truncated = true;
  await assert.rejects(workspaces.recover(id), /incomplete/);
  assert.equal(workspaces.get(id).phase, 'recovery_required');
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
});

test('Orca instance replacement at the same path is rejected while ordinary comment edits are allowed', async t => {
  const { repo, task, workspaces, state } = fixture(t);
  const created = await workspaces.createOrca(task.id, 1, repo, 'main');
  state.worktree!['comment'] = 'User edited the status';
  assert.equal((await workspaces.inspect(created.id)).dirty, false);
  state.worktree!['instanceId'] = 'instance-b';
  state.worktree!['identity'] = { key: 'wt2:local:instance-b', instanceId: 'instance-b', executionHostId: 'local' };
  await assert.rejects(workspaces.inspect(created.id), /instance.*changed/);
});

test('Orca recovery refuses an altered base or dirty checkout and never resets changes', async t => {
  const { repo, task, workspaces, state } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'));
  const saved = workspaces.list()[0]!;
  state.worktree!['baseRef'] = 'other-base';
  await assert.rejects(workspaces.recover(saved.id), /does not match/);
  state.worktree!['baseRef'] = saved.baseCommit;
  writeFileSync(join(String(state.worktree!['path']), 'extra.txt'), 'preserve this');
  await assert.rejects(workspaces.recover(saved.id), /clean base commit/);
  assert.equal(workspaces.get(saved.id).phase, 'recovery_required');
  assert.match(git(String(state.worktree!['path']), 'status', '--porcelain'), /extra.txt/);
});

test('Orca compatibility and approval failures stop before reserving or creating a workspace', async t => {
  const { repo, task, workspaces, state, requests } = fixture(t);
  await assert.rejects(workspaces.createOrca(task.id, 2, repo, 'main'), /exact approved/);
  state.old = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'), /lacks required/);
  assert.equal(workspaces.list().length, 0);
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 0);
});

test('Orca and standalone creation share one task reservation', async t => {
  const { root, repo, task, workspaces, state, requests } = fixture(t);
  state.loseReply = true;
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'));
  await assert.rejects(workspaces.create(task.id, 1, repo, join(root, 'duplicate')), /reservation/);
  await assert.rejects(workspaces.createOrca(task.id, 1, repo, 'main'), /reservation/);
  assert.equal(workspaces.list().length, 1);
  assert.equal(requests.filter(args => args[1] === 'create' && !args.includes('--help')).length, 1);
});

test('Orca protocol rejects remote identity, incomplete listing and malformed responses', async () => {
  const list = (result: unknown) => new OrcaCli(async () => JSON.stringify({ ok: true, result })).list('.', 'repo');
  await assert.rejects(
    list({ worktrees: [], truncated: false, totalCount: 1, hostScope: { hostIds: ['local'], omittedHostIds: [] } }),
    /incomplete/,
  );
  await assert.rejects(
    list({ worktrees: [], truncated: false, totalCount: 0, hostScope: { hostIds: ['remote'], omittedHostIds: [] } }),
    /another host/,
  );
  await assert.rejects(new OrcaCli(async () => '{bad json').show('.', 'identity'));
  await assert.rejects(
    new OrcaCli(async () => JSON.stringify({ ok: false, error: { code: 'repo_not_found' } })).show('.', 'identity'),
    /repo_not_found/,
  );
  await assert.rejects(
    new OrcaCli(async () =>
      JSON.stringify({ ok: true, result: { worktree: { hostId: 'remote', identity: { executionHostId: 'remote' } } } }),
    ).show('.', 'identity'),
    /Only local/,
  );
});

test('Orca execution holds a lease during identity inspection and refuses a replaced instance before dispatch', async t => {
  const { repo, store, task, workspaces, state } = fixture(t);
  const workspace = await workspaces.createOrca(task.id, 1, repo, 'main');
  const execution = await new Executions(store, workspaces).create(workspace.id, 1, 'codex');
  let turns = 0;
  const connector: Connector = async () => {
    assert.ok(store.lease(workspace.id));
    return {
      turn: async () => {
        turns++;
        return {
          status: 'completed',
          reply: { kind: 'message', text: 'Fixture', questions: [], findings: [] },
          usage: null,
          error: null,
        };
      },
      interrupt: async () => {},
      close: async () => {
        assert.ok(store.lease(workspace.id));
      },
    };
  };
  assert.equal((await runSession(store, execution.sessionId, 'First', {}, connector, workspaces)).status, 'completed');
  assert.equal(store.lease(workspace.id), null);
  state.worktree!['instanceId'] = 'replacement';
  state.worktree!['identity'] = { key: 'wt2:local:replacement', instanceId: 'replacement', executionHostId: 'local' };
  assert.equal((await runSession(store, execution.sessionId, 'Second', {}, connector, workspaces)).status, 'failed');
  assert.equal(turns, 1);
  assert.equal(store.lease(workspace.id), null);
});

test(
  'both native providers can edit an Orca workspace without changing its lifecycle or accepting gates',
  windows,
  async t => {
    for (const provider of ['claude', 'codex'] as const) {
      const f = await implementationFixture(t, provider);
      const run = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
        assert.equal(f.store.lease(f.workspace.id)?.kind, 'implementation');
        return editedResult(options);
      });
      assert.equal(run.phase, 'completed', run.error ?? undefined);
      assert.equal(f.workflow.get(f.task.id).phase, 'running');
      assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
      assert.equal(new Sessions(f.store).get(f.execution.sessionId).mode, 'editing');
      assert.equal(f.store.lease(f.workspace.id), null);
      assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.workspace.baseCommit);
      assert.ok(f.requests.every(args => ['repo', 'worktree'].includes(args[0]!) && !['set', 'rm'].includes(args[1]!)));
    }
  },
);

test(
  'Orca editing refuses changed identity before dispatch and cannot accept edits after archival',
  windows,
  async t => {
    const f = await implementationFixture(t);
    let dispatched = false;
    f.state.worktree!['instanceId'] = 'replacement';
    const rejected = await f.implementations.run(f.execution.id, f.policy, undefined, {}, async options => {
      dispatched = true;
      return editedResult(options);
    });
    assert.equal(dispatched, false);
    assert.equal(rejected.phase, 'failed');
    assert.equal(rejected.dispatch, 'not_requested');
    const g = await implementationFixture(t);
    const edited = await g.implementations.run(g.execution.id, g.policy, undefined, {}, async options => {
      const result = editedResult(options);
      g.state.worktree!['isArchived'] = true;
      return result;
    });
    assert.equal(edited.phase, 'failed');
    assert.match(edited.error!, /changed/);
    assert.equal(readFileSync(join(g.workspace.path, 'greeting.txt'), 'utf8'), 'hello world\n');
    assert.equal(g.store.lease(g.workspace.id), null); // Exit is proven; failed edits stay intact.
  },
);
