// Check tests: snapshots, execution, submission and the check CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { Executions } from '../src/execution/executions.js';
import { Checks, type CheckSpec, type RepositoryCheck } from '../src/verification/checks.js';
import { windows, git, fixture } from './helpers/checks.js';

test('real check records content and output, then explicit submission passes only validation', windows, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('hello world');\n");
  const spec = await f.spec(
    "const {execFileSync}=require('node:child_process'); const assert=require('node:assert/strict'); assert.equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n'); console.log('greeting verified');",
  );
  const check = await f.checks.run(f.execution.id, spec);
  assert.equal(check.phase, 'passed', JSON.stringify(check));
  assert.equal(check.result?.stdout, 'greeting verified\n');
  assert.equal(check.result?.exitConfirmed, true);
  assert.ok(check.supervisorPid);
  assert.ok(check.toolPid);
  assert.equal(check.before!.diff.find(item => item.path === 'greeting.js')?.content, "console.log('hello world');\n");
  assert.equal(
    check.before!.diff.find(item => item.path === 'greeting.js')?.previousContent,
    "console.log('hello');\n",
  );
  assert.equal(f.workflow.get(f.task.id).phase, 'running');
  assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  assert.equal(f.store.lease(f.workspace.id), null);
  const reopened = new Store(f.db);
  try {
    await new Checks(reopened).finish(f.execution.id, check.id);
  } finally {
    reopened.close();
  }
  const task = f.workflow.get(f.task.id);
  assert.equal(task.phase, 'awaiting_verification');
  assert.equal(task.attempt?.artifact, check.after!.artifact);
  assert.deepEqual(
    task.evidence.map(item => item.kind),
    ['validation'],
  );
  assert.throws(() => f.workflow.complete(task.id), /simplification.*review.*verification/);
});

test('snapshots bind index, untracked files and inherited instructions while excluding ignored build output', async t => {
  const f = await fixture(t);
  const initial = await f.checks.snapshot(f.execution.id);
  assert.ok(initial.instructions.some(item => item.path === 'AGENTS.md'));
  mkdirSync(join(f.workspace.path, 'generated'));
  writeFileSync(join(f.workspace.path, 'generated', 'out'), 'build');
  assert.equal((await f.checks.snapshot(f.execution.id)).artifact, initial.artifact);
  writeFileSync(join(f.workspace.path, 'new.txt'), 'new');
  const untracked = await f.checks.snapshot(f.execution.id);
  assert.notEqual(untracked.artifact, initial.artifact);
  git(f.workspace.path, 'add', 'new.txt');
  assert.notEqual((await f.checks.snapshot(f.execution.id)).artifact, untracked.artifact);
  writeFileSync(join(f.root, 'CLAUDE.md'), 'Inherited fixture instructions');
  const inherited = await f.checks.snapshot(f.execution.id);
  assert.ok(inherited.instructions.some(item => item.path === '<ancestor:1>/CLAUDE.md'));
  assert.notEqual(inherited.instructionsDigest, initial.instructionsDigest);
});

test('stale artifact and instruction acknowledgements reject dispatch and preserve attempt state', async t => {
  const f = await fixture(t);
  const spec = await f.spec();
  writeFileSync(join(f.workspace.path, 'AGENTS.md'), 'New rule');
  let called = false;
  const check = await f.checks.run(f.execution.id, spec, undefined, async () => {
    called = true;
    throw new Error('Unexpected dispatch');
  });
  assert.equal(called, false);
  assert.equal(check.phase, 'failed');
  assert.match(check.error!, /instructions changed/);
  assert.equal(f.workflow.get(f.task.id).phase, 'running');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('checks share the session lease, persist intent before dispatch and reject duplicate ownership', async t => {
  const f = await fixture(t);
  const spec = await f.spec();
  const check = await f.checks.run(f.execution.id, spec, undefined, async () => {
    assert.equal(f.store.checks<RepositoryCheck>(f.execution.id).at(-1)?.phase, 'running');
    assert.equal(f.store.executionEvents(f.execution.id).at(-1)?.type, 'check.dispatch_requested');
    assert.throws(() => new Sessions(f.store).claim(f.execution.sessionId, 'Compete'), /lease/);
    await assert.rejects(
      f.checks.run(f.execution.id, spec, undefined, async () => {
        throw new Error('Unexpected dispatch');
      }),
      /lease/,
    );
    assert.throws(() => f.executions.close(f.execution.id), /lease/);
    return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
  });
  assert.equal(check.phase, 'passed');
});

test(
  'failed and mutating commands remain failures; an older passing result cannot hide a newer failure',
  windows,
  async t => {
    const f = await fixture(t);
    const pass = await f.checks.run(f.execution.id, await f.spec());
    assert.equal(pass.phase, 'passed');
    const failed = await f.checks.run(f.execution.id, await f.spec("console.error('broken'); process.exit(7)"));
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.result?.exitCode, 7);
    assert.equal(failed.result?.stderr, 'broken\n');
    await assert.rejects(f.checks.finish(f.execution.id, pass.id), /latest check/);
    const changed = await f.checks.run(
      f.execution.id,
      await f.spec("require('node:fs').writeFileSync('greeting.js','changed')"),
    );
    assert.equal(changed.phase, 'failed');
    assert.match(changed.error!, /changed repository/);
    assert.notEqual(changed.before!.artifact, changed.after!.artifact);
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
  },
);

test(
  'submission rechecks repository state and rolls back both success and evidence on journal failure',
  windows,
  async t => {
    const f = await fixture(t);
    const check = await f.checks.run(f.execution.id, await f.spec());
    writeFileSync(join(f.workspace.path, 'new.txt'), 'later edit');
    await assert.rejects(f.checks.finish(f.execution.id, check.id), /changed after the check/);
    rmSync(join(f.workspace.path, 'new.txt'));
    const append = f.store.append.bind(f.store);
    f.store.append = (id, version, type, data) => {
      if (type === 'evidence.recorded') throw new Error('Fixture journal failure');
      append(id, version, type, data);
    };
    await assert.rejects(f.checks.finish(f.execution.id, check.id), /journal failure/);
    f.store.append = append;
    assert.equal(f.workflow.get(f.task.id).phase, 'running');
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.equal(f.store.lease(f.workspace.id), null);
    await f.checks.finish(f.execution.id, check.id);
  },
);

test('unknown tool shutdown keeps ownership across restarts and cannot use conversation recovery', async t => {
  const f = await fixture(t);
  const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async () => {
    throw new Error('Lost supervisor');
  });
  assert.equal(check.phase, 'recovery_required');
  assert.ok(f.store.lease(f.workspace.id));
  assert.equal(f.workflow.get(f.task.id).phase, 'recovery_required');
  const reopened = new Store(f.db);
  try {
    assert.equal(new Checks(reopened).get(check.id).phase, 'recovery_required');
    assert.throws(() => new Sessions(reopened).recover(f.execution.sessionId), /does not need recovery/);
    assert.throws(() => new Executions(reopened).close(f.execution.id), /lease/);
  } finally {
    reopened.close();
  }
});

test('CLI snapshots, executes and submits a check across separate controllers without inference', windows, async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args, '--db', f.db], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ) as Record<string, unknown>;
  const snapshot = invoke('execution-snapshot', f.execution.id);
  const specFile = join(f.root, 'check.json');
  writeFileSync(
    specFile,
    JSON.stringify({
      name: 'CLI fixture',
      file: process.execPath,
      args: ['greeting.js'],
      timeoutMs: 3000,
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
    }),
  );
  const check = invoke('execution-check', f.execution.id, specFile);
  assert.equal(check.phase, 'passed');
  assert.equal(invoke('check-show', check.id as string).id, check.id);
  assert.equal(invoke('execution-finish', f.execution.id, check.id as string).phase, 'awaiting_verification');
  const acceptance = {
    name: 'Greeting acceptance',
    file: process.execPath,
    args: ['greeting.js'],
    timeoutMs: 3000,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    criteria: ['Print hello'],
    expectedStdout: 'hello\n',
  };
  writeFileSync(specFile, JSON.stringify(acceptance));
  assert.equal(invoke('execution-verify', f.execution.id, specFile).phase, 'passed');
  assert.throws(() => invoke('execution-complete', f.execution.id), /simplification/);
});

test('invalid options and unsupported snapshot file types fail before dispatch or evidence', async t => {
  const f = await fixture(t);
  const spec = await f.spec();
  await assert.rejects(f.checks.run(f.execution.id, { ...spec, cwd: f.repo } as CheckSpec), /Unknown check option/);
  assert.deepEqual(f.store.checks(f.execution.id), []);
  const oid = git(f.workspace.path, 'rev-parse', 'HEAD');
  git(f.workspace.path, 'update-index', '--add', '--cacheinfo', `160000,${oid},nested`);
  await assert.rejects(f.checks.snapshot(f.execution.id), /submodules/);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
});
