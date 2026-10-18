import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/persistence/store.js';
import { Workflow } from '../src/domain/workflow.js';
import { Workspaces } from '../src/repository/workspaces.js';
import { Sessions, runSession } from '../src/execution/sessions.js';
import { Executions } from '../src/execution/executions.js';
import type { Execution, ExecutionLease } from '../src/execution/execution-state.js';
import type { AgentSession, Connector, Reply, TurnResult } from '../src/providers/types.js';

const brief = { title: 'Greeting', outcome: 'Say hello', criteria: ['Print hello'], plan: 'Implement and verify' };
const message: Reply = { kind: 'message', text: 'Conversation complete', questions: [], findings: [] };
const result = (reply: Reply = message): TurnResult => ({ status: 'completed', reply, usage: null, error: null });
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-execution-test-'));
  const repo = join(root, 'source');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Fixture baseline');
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
  const sessions = new Sessions(store);
  return { root, repo, db, store, workflow, task, workspace, workspaces, executions, sessions };
}

test('execution preparation atomically links an approved attempt, workspace and fresh session', async t => {
  const { store, workflow, task, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  assert.equal(execution.attemptId, workflow.get(task.id).attempt?.id);
  assert.equal(workflow.get(task.id).attempt?.agent.sessionId, execution.sessionId);
  assert.equal(sessions.get(execution.sessionId).cwd, workspace.path);
  assert.equal(sessions.get(execution.sessionId).providerSessionId, null);
  assert.equal(store.lease(workspace.id), null);
  assert.equal(store.executionForSession<Execution>(execution.sessionId)?.id, execution.id);
  assert.equal(workflow.get(task.id).phase, 'running');
});

test('failed execution preparation rolls back nested task/session changes and all their events', async t => {
  const { store, workflow, task, workspace, executions } = await fixture(t);
  const before = store.events(task.id);
  const append = store.appendExecution.bind(store);
  store.appendExecution = () => {
    throw new Error('Fixture journal write failure');
  };
  await assert.rejects(executions.create(workspace.id, 1, 'codex'), /journal write failure/);
  store.appendExecution = append;
  assert.equal(workflow.get(task.id).phase, 'ready');
  assert.equal(workflow.get(task.id).attempt, null);
  assert.deepEqual(store.events(task.id), before);
  assert.deepEqual(store.sessions(), []);
  assert.deepEqual(executions.list(), []);
  assert.ok((await executions.create(workspace.id, 1, 'codex')).id);
});

test('questions resume across stores with approved context and release ownership only after shutdown', async t => {
  const { db, store, workflow, task, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  let turns = 0;
  const prompts: string[] = [];
  const connector: Connector = async (_, options) => {
    assert.ok(store.lease(workspace.id));
    assert.equal(options.providerSessionId, turns === 0 ? null : 'fixture-provider-session');
    options.emit({
      type: 'session.connected',
      data: { providerSessionId: 'fixture-provider-session', model: 'observed-fixture-model' },
    });
    return {
      turn: async prompt => {
        prompts.push(prompt);
        turns++;
        return result(
          turns === 1
            ? {
                kind: 'question',
                text: 'Choose',
                questions: [{ id: 'format', prompt: 'Which?', choices: [] }],
                findings: [],
              }
            : message,
        );
      },
      interrupt: async () => {},
      close: async () => {
        assert.ok(store.lease(workspace.id));
      },
    };
  };
  await runSession(store, execution.sessionId, 'Ask a question', {}, connector);
  assert.equal(sessions.get(execution.sessionId).phase, 'awaiting_answer');
  assert.equal(store.lease(workspace.id), null);
  const reopened = new Store(db);
  try {
    await runSession(reopened, execution.sessionId, '', { answers: { format: 'text' } }, connector);
  } finally {
    reopened.close();
  }
  assert.match(prompts[0]!, /Print hello/);
  assert.match(prompts[1]!, /"format":"text"/);
  assert.equal(workflow.get(task.id).attempt?.agent.model, 'observed-fixture-model');
  assert.equal(workflow.get(task.id).phase, 'running');
  assert.equal(workflow.get(task.id).attempt?.artifact, null);
  assert.deepEqual(workflow.get(task.id).evidence, []);
});

test('different review sessions share one workspace lease and late results cannot release the new owner', async t => {
  const { db, store, workflow, task, workspace, executions, sessions } = await fixture(t);
  const implementation = await executions.create(workspace.id, 1, 'codex');
  workflow.finish(task.id, implementation.attemptId, 1, 'succeeded', 'fixture-artifact', 'Trusted fixture result');
  const first = await executions.create(workspace.id, 1, 'claude', 'review');
  const second = await executions.create(workspace.id, 1, 'claude', 'review');
  const claim = sessions.claim(first.sessionId, 'Review');
  const otherStore = new Store(db);
  try {
    const other = new Sessions(otherStore);
    assert.throws(() => other.claim(second.sessionId, 'Duplicate'), /execution lease/);
    assert.throws(
      () => workflow.start(task.id, { provider: 'codex', model: 'fixture', sessionId: 'other' }),
      /execution lease/,
    );
    assert.throws(
      () =>
        workflow.record(task.id, {
          id: 'check',
          attemptId: implementation.attemptId,
          version: 1,
          artifact: 'fixture-artifact',
          kind: 'validation',
          source: 'controller',
          outcome: 'passed',
          summary: 'Fixture',
        }),
      /execution lease/,
    );
    assert.ok(workflow.blockers(task.id).some(reason => reason.includes('execution')));
    sessions.settle(first.sessionId, claim.runId, result(), true);
    const next = other.claim(second.sessionId, 'Next');
    sessions.settle(first.sessionId, claim.runId, result(), true);
    assert.equal(store.lease<ExecutionLease>(workspace.id)?.runId, next.runId);
    other.settle(second.sessionId, next.runId, result(), true);
  } finally {
    otherStore.close();
  }
  assert.equal(store.lease(workspace.id), null);
  assert.deepEqual(workflow.get(task.id).evidence, []);
});

test('unconfirmed shutdown retains the lease and blocks task mutation until confirmed recovery', async t => {
  const { store, workflow, task, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const connector: Connector = async (_, options) => {
    options.emit({ type: 'process.started', data: { pid: process.pid } });
    return {
      turn: async () => result(),
      interrupt: async () => {},
      close: async () => {
        throw new Error('Unconfirmed fixture shutdown');
      },
    };
  };
  await runSession(store, execution.sessionId, 'Run', {}, connector);
  assert.equal(sessions.get(execution.sessionId).phase, 'recovery_required');
  assert.equal(workflow.get(task.id).phase, 'recovery_required');
  assert.ok(store.lease(workspace.id));
  assert.throws(() => executions.close(execution.id), /execution lease/);
  await assert.rejects(executions.create(workspace.id, 1, 'codex'), /execution lease/);
  assert.throws(() => workflow.confirmStopped(task.id, execution.attemptId, 'Unproven'), /execution lease/);
  assert.throws(() => sessions.recover(execution.sessionId), /controller is still alive/);
  sessions.recover(execution.sessionId, () => false);
  assert.equal(store.lease(workspace.id), null);
  assert.equal(workflow.get(task.id).phase, 'stopped');
  const next = await executions.create(workspace.id, 1, 'codex');
  assert.notEqual(next.attemptId, execution.attemptId);
  assert.throws(() => sessions.claim(execution.sessionId, 'Stale attempt'), /outdated task attempt/);
});

test('a missing provider PID after a crash cannot free a linked workspace lease', async t => {
  const { store, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  sessions.claim(execution.sessionId, 'Uncertain dispatch');
  assert.throws(() => sessions.recover(execution.sessionId, () => false), /Provider exit is unconfirmed/);
  assert.ok(store.lease(workspace.id));
});

test('a real controller crash retains the lease until both recorded processes have exited', async t => {
  const { db, store, workflow, task, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const script = `
    const { Store } = await import(process.argv[1]);
    const { Sessions } = await import(process.argv[2]);
    const { spawn } = await import('node:child_process');
    const store = new Store(process.argv[3]);
    const sessions = new Sessions(store);
    const claim = sessions.claim(process.argv[4], 'Claim before crash');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {windowsHide:true});
    sessions.event(process.argv[4], claim.runId, {type:'process.started',data:{pid:child.pid}});
    await new Promise(resolve => child.on('close', resolve));
    process.exit(0);
  `;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      new URL('../src/persistence/store.js', import.meta.url).href,
      new URL('../src/execution/sessions.js', import.meta.url).href,
      db,
      execution.sessionId,
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  assert.ok(store.lease(workspace.id));
  assert.throws(() => workflow.recover(), /execution lease/);
  sessions.recover(execution.sessionId);
  assert.equal(store.lease(workspace.id), null);
  assert.equal(workflow.get(task.id).phase, 'stopped');
  assert.equal(sessions.get(execution.sessionId).run, null);
});

test('interruption is persisted before provider interrupt and late success cannot complete the attempt', async t => {
  const { store, workflow, task, workspace, executions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const abort = new AbortController();
  let finish!: (value: TurnResult) => void;
  const connector: Connector = async () => ({
    turn: async () => {
      const pending = new Promise<TurnResult>(resolve => {
        finish = resolve;
      });
      queueMicrotask(() => abort.abort());
      return pending;
    },
    interrupt: async () => {
      assert.equal(workflow.get(task.id).phase, 'stop_requested');
      assert.ok(store.lease(workspace.id));
      finish(result());
    },
    close: async () => {},
  });
  const outcome = await runSession(store, execution.sessionId, 'Run', { signal: abort.signal }, connector);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(workflow.get(task.id).phase, 'stopped');
  assert.equal(workflow.get(task.id).attempt?.artifact, null);
  assert.equal(store.lease(workspace.id), null);
});

test('workspace identity failure is detected while leased and before any provider dispatch', async t => {
  const { repo, store, workflow, task, workspace, executions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  git(repo, 'worktree', 'unlock', workspace.path);
  let connected = false;
  const connector: Connector = async () => {
    connected = true;
    throw new Error('Must not connect');
  };
  const outcome = await runSession(store, execution.sessionId, 'Run', {}, connector);
  assert.equal(outcome.status, 'failed');
  assert.equal(connected, false);
  assert.equal(store.lease(workspace.id), null);
  assert.equal(workflow.get(task.id).phase, 'failed');
});

test('malformed replies fail the attempt but do not retain a lease after confirmed shutdown', async t => {
  const { store, workflow, task, workspace, executions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const connector: Connector = async () => ({
    turn: async () => ({ ...result(), reply: null }),
    interrupt: async () => {},
    close: async () => {},
  });
  assert.equal((await runSession(store, execution.sessionId, 'Run', {}, connector)).status, 'failed');
  assert.equal(workflow.get(task.id).phase, 'failed');
  assert.equal(store.lease(workspace.id), null);
});

test('review requires a successful artifact and a fresh session with explicit same-provider fallback', async t => {
  const { workflow, task, workspace, executions, sessions } = await fixture(t);
  const implementation = await executions.create(workspace.id, 1, 'codex');
  await assert.rejects(executions.create(workspace.id, 1, 'claude', 'review'), /successful current attempt/);
  workflow.finish(task.id, implementation.attemptId, 1, 'succeeded', 'fixture-artifact', 'Fixture');
  await assert.rejects(executions.create(workspace.id, 1, 'codex', 'review'), /fallback reason/);
  const review = await executions.create(workspace.id, 1, 'codex', 'review', null, 'Other provider unavailable');
  assert.notEqual(review.sessionId, implementation.sessionId);
  assert.equal(review.artifact, 'fixture-artifact');
  assert.equal(sessions.get(review.sessionId).providerSessionId, null);
  workflow.revise(task.id, 1, { ...brief, title: 'Changed brief' });
  assert.throws(() => sessions.claim(review.sessionId, 'Outdated review'), /outdated task attempt/);
});

test('closing an idle execution stops its attempt and never force-releases an active lease', async t => {
  const { workflow, task, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const claim = sessions.claim(execution.sessionId, 'Run');
  assert.throws(() => executions.close(execution.id), /execution lease/);
  sessions.settle(execution.sessionId, claim.runId, result(), true);
  executions.close(execution.id);
  assert.equal(workflow.get(task.id).phase, 'stopped');
  assert.equal(executions.get(execution.id).phase, 'closed');
  assert.throws(() => sessions.claim(execution.sessionId, 'Reuse'), /closed/);
});

test('unlinked sessions cannot bypass workspace ownership, and removed unrelated workspaces do not block them', async t => {
  const { root, repo, workspace, sessions } = await fixture(t);
  mkdirSync(join(workspace.path, 'subfolder'));
  const unlinked = sessions.create('codex', join(workspace.path, 'subfolder'));
  assert.throws(() => sessions.claim(unlinked.id, 'Bypass'), /execution-linked/);
  git(repo, 'worktree', 'unlock', workspace.path);
  git(repo, 'worktree', 'remove', '--force', workspace.path);
  const unrelated = sessions.create('codex', root);
  const claim = sessions.claim(unrelated.id, 'Normal conversation');
  sessions.settle(unrelated.id, claim.runId, result(), true);
});

test('execution CLI persists linked state and closes it across separate invocations without inference', async t => {
  const { db, workspace } = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [cli, '--db', db, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const execution = JSON.parse(run('execution-new', workspace.id, '1', 'codex'));
  const shown = JSON.parse(run('execution-show', execution.id));
  assert.equal(shown.session.id, execution.sessionId);
  assert.equal(shown.lease, null);
  assert.equal(JSON.parse(run('session-show', execution.sessionId)).execution.id, execution.id);
  assert.equal(JSON.parse(run('execution-close', execution.id)).phase, 'closed');
  assert.equal(JSON.parse(run('execution-list')).length, 1);
});

test('a legacy unlinked active session blocks a new workspace owner after migration', async t => {
  const { store, workspace, executions, sessions } = await fixture(t);
  const legacy = sessions.create('codex', workspace.path);
  legacy.phase = 'running';
  legacy.run = { id: 'legacy-run', controllerPid: process.pid, providerPid: null, host: hostname() };
  store.saveSession(legacy.id, legacy);
  const execution = await executions.create(workspace.id, 1, 'claude');
  assert.throws(() => sessions.claim(execution.sessionId, 'Do not overlap'), /another active or uncertain session/);
  assert.equal(store.lease(workspace.id), null);
  assert.equal(sessions.get(execution.sessionId).phase, 'idle');
});

test('schema 4 migration retains workspaces and sessions and adds execution ownership', async t => {
  const { db, store, workflow, task, workspace, sessions } = await fixture(t);
  const session = sessions.create('codex', workspace.repository);
  const legacy = new DatabaseSync(db);
  legacy.exec(
    'DROP TABLE execution_leases; DROP TABLE execution_events; DROP TABLE executions; PRAGMA user_version = 4;',
  );
  legacy.close();
  const reopened = new Store(db);
  try {
    assert.deepEqual(new Workflow(reopened).get(task.id), workflow.get(task.id));
    assert.deepEqual(reopened.session(session.id), store.session(session.id));
    assert.deepEqual(reopened.workspace(workspace.id), workspace);
    assert.ok((await new Executions(reopened).create(workspace.id, 1, 'codex')).id);
  } finally {
    reopened.close();
  }
});

test('different task workspaces can own concurrent turns in the same journal', async t => {
  const { root, repo, store, workflow, workspace, workspaces, executions, sessions } = await fixture(t);
  const first = await executions.create(workspace.id, 1, 'codex');
  const firstRun = sessions.claim(first.sessionId, 'First task');
  const otherTask = workflow.create(brief);
  workflow.approve(otherTask.id, 1);
  const otherWorkspace = await workspaces.create(otherTask.id, 1, repo, join(root, 'other-workspace'));
  const second = await executions.create(otherWorkspace.id, 1, 'claude');
  const secondRun = sessions.claim(second.sessionId, 'Independent task');
  assert.ok(store.lease(workspace.id));
  assert.ok(store.lease(otherWorkspace.id));
  sessions.settle(first.sessionId, firstRun.runId, result(), true);
  assert.ok(store.lease(otherWorkspace.id));
  sessions.settle(second.sessionId, secondRun.runId, result(), true);
});

test('startup that outlives cancellation retains its lease even before a provider PID is observed', async t => {
  const { store, workflow, task, workspace, executions, sessions } = await fixture(t);
  const execution = await executions.create(workspace.id, 1, 'codex');
  let resolveConnection!: (session: AgentSession) => void;
  const connector: Connector = async () =>
    new Promise(resolve => {
      resolveConnection = resolve;
    });
  let closed = false;
  const outcome = await runSession(store, execution.sessionId, 'Slow startup', { timeoutMs: 1000 }, connector);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(sessions.get(execution.sessionId).phase, 'recovery_required');
  assert.equal(workflow.get(task.id).phase, 'recovery_required');
  assert.ok(store.lease(workspace.id));
  resolveConnection({
    turn: async () => {
      throw new Error('Must never send after timeout');
    },
    interrupt: async () => {},
    close: async () => {
      closed = true;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
  assert.ok(store.lease(workspace.id));
});
