// Check tests: tool supervision, crashes, receipts and journal migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Checks, type RepositoryCheck } from '../src/checks.js';
import { runCheckProcess } from '../src/check-process.js';
import { processAlive } from '../src/check-recovery.js';
import { windows, fixture, alive, deadController, crashDuringInspection } from './helpers/checks.js';

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Fixture wait timed out');
    await delay(25);
  }
}

test('job supervision passes literal Unicode arguments and records a failed executable launch', windows, async () => {
  const args = ['a b', 'quote"end', 'trailing\\', '$(not-a-command)', 'héllo 🌊', ''];
  const result = await runCheckProcess({
    file: process.execPath,
    args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args],
    cwd: process.cwd(),
    timeoutMs: 3000,
    started: () => {},
  });
  assert.equal(result.reason, 'exited');
  assert.equal(result.exitConfirmed, true);
  assert.deepEqual(JSON.parse(result.stdout), args);
  const missing = await runCheckProcess({
    file: join(tmpdir(), 'grampus-missing-executable.exe'),
    args: [],
    cwd: process.cwd(),
    timeoutMs: 1000,
    started: () => {},
  });
  assert.equal(missing.reason, 'supervisor_error');
  assert.equal(missing.exitConfirmed, true);
});

test('rapid zero-exit tools wait for job settlement instead of failing on transient accounting', windows, async () => {
  for (let batch = 0; batch < 6; batch++) {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runCheckProcess({
          file: process.execPath,
          args: ['-e', 'process.stdout.write("settled")'],
          cwd: process.cwd(),
          timeoutMs: 3000,
          started: () => {},
        }),
      ),
    );
    for (const result of results) {
      assert.equal(result.reason, 'exited', JSON.stringify(result));
      assert.equal(result.exitCode, 0);
      assert.equal(result.exitConfirmed, true);
      assert.equal(result.stdout, 'settled');
    }
  }
});

test('timeout terminates a real tool tree before releasing the workspace', windows, async t => {
  const f = await fixture(t);
  const identityModule = JSON.stringify(new URL('../src/process-identity.js', import.meta.url).href);
  const spec =
    await f.spec(`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    import(${identityModule}).then(({inspectProcess}) => console.log(JSON.stringify({ childPid: child.pid, tool: inspectProcess(process.pid), child: inspectProcess(child.pid) })));
    setInterval(()=>{},1000);`);
  // Leave time to observe both creation times before the actual timeout. A later
  // repository capture can give Windows enough time to recycle the exited PIDs.
  spec.timeoutMs = 5000;
  const check = await f.checks.run(f.execution.id, spec);
  assert.equal(check.phase, 'failed');
  assert.equal(check.result?.reason, 'timed_out');
  assert.equal(check.result.exitConfirmed, true);
  const identities = JSON.parse(check.result.stdout.trim()) as {
    childPid: number;
    tool: { state: string; startedAt: string };
    child: { state: string; startedAt: string };
  };
  assert.equal(identities.tool.state, 'present');
  assert.equal(identities.child.state, 'present');
  assert.ok(Number.isSafeInteger(identities.childPid) && identities.childPid > 0);
  assert.equal(processAlive(check.toolPid!, identities.tool.startedAt), false);
  assert.equal(processAlive(identities.childPid, identities.child.startedAt), false);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
});

test('a zero-exit tool leaving a detached child is failed and its child is terminated', windows, async () => {
  const result = await runCheckProcess({
    file: process.execPath,
    args: [
      '-e',
      "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); console.log(child.pid); child.unref();",
    ],
    cwd: process.cwd(),
    timeoutMs: 3000,
    started: () => {},
  });
  assert.equal(result.reason, 'descendants_remaining');
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitConfirmed, true);
  assert.equal(alive(Number(result.stdout.trim())), false);
});

test('cancellation stops actual tools and excessive output is bounded and unsuccessful', windows, async () => {
  const abort = new AbortController();
  let toolPid = 0;
  const result = await runCheckProcess({
    file: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    timeoutMs: 3000,
    signal: abort.signal,
    started: (kind, pid) => {
      if (kind === 'tool') {
        toolPid = pid;
        abort.abort();
      }
    },
  });
  assert.equal(result.reason, 'interrupted');
  assert.equal(result.exitConfirmed, true);
  assert.equal(alive(toolPid), false);
  const noisy = await runCheckProcess({
    file: process.execPath,
    args: ['-e', "const fs=require('node:fs'); const b=Buffer.alloc(100000,'x'); setInterval(()=>fs.writeSync(1,b),1)"],
    cwd: process.cwd(),
    timeoutMs: 3000,
    started: () => {},
  });
  assert.equal(noisy.reason, 'output_limit');
  assert.equal(noisy.exitConfirmed, true);
  assert.equal(noisy.outputTruncated, true);
  assert.ok(noisy.stdout.length <= 65536);
});

test(
  'controller crash shuts down its tree and explicit receipt recovery releases ownership without replay',
  windows,
  async t => {
    const f = await fixture(t);
    const childFile = join(f.root, 'child-pid');
    const spec = await f.spec(
      `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(child.pid)); setInterval(()=>{},1000);`,
    );
    const specFile = join(f.root, 'check.json');
    writeFileSync(specFile, JSON.stringify(spec));
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const controller = execFile(process.execPath, [cli, 'execution-check', f.execution.id, specFile, '--db', f.db], {
      windowsHide: true,
    });
    controller.on('error', () => {});
    const closed = new Promise<void>(resolve => controller.once('close', () => resolve()));
    t.after(() => controller.kill());
    await waitFor(() => {
      try {
        return Number(readFileSync(childFile, 'utf8')) > 0;
      } catch {
        return false;
      }
    });
    const check = f.store.checks<RepositoryCheck>(f.execution.id).at(-1)!;
    const childPid = Number(readFileSync(childFile, 'utf8'));
    controller.kill();
    await closed;
    await waitFor(() => !alive(check.toolPid!) && !alive(childPid) && !alive(check.supervisorPid!));
    assert.ok(f.store.lease(f.workspace.id));
    assert.equal(f.checks.get(check.id).phase, 'running'); // No final controller transaction was committed.
    assert.throws(() => f.executions.close(f.execution.id), /lease/);
    const recovered = JSON.parse(
      execFileSync(process.execPath, [cli, 'check-recover', check.id, '--db', f.db], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ) as RepositoryCheck;
    assert.equal(recovered.phase, 'interrupted');
    assert.equal(recovered.result?.exitConfirmed, true);
    assert.equal(f.store.lease(f.workspace.id), null);
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.throws(() => f.checks.recover(check.id), /lease/);
  },
);

test('schema 5 journals migrate without losing linked records', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.db);
  db.exec('DROP TABLE checks; PRAGMA user_version = 5;');
  db.close();
  const migrated = new Store(f.db);
  try {
    assert.deepEqual(migrated.execution(f.execution.id), f.execution);
    assert.deepEqual(migrated.checks(f.execution.id), []);
  } finally {
    migrated.close();
  }
});

test('supervisor death kills its job but does not invent exit confirmation', windows, async () => {
  let supervisorPid = 0;
  let toolPid = 0;
  const result = await runCheckProcess({
    file: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    timeoutMs: 3000,
    started: (kind, pid) => {
      if (kind === 'supervisor') supervisorPid = pid;
      else {
        toolPid = pid;
        process.kill(supervisorPid);
      }
    },
  });
  assert.equal(result.reason, 'supervisor_lost');
  assert.equal(result.exitConfirmed, false);
  await waitFor(() => !alive(toolPid));
});

test(
  'completion receipt rejects wrong tokens, partial settlement, process mismatch and live owners',
  windows,
  async t => {
    const f = await fixture(t);
    const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async options => {
      await runCheckProcess(options);
      throw new Error('Simulated lost final reply');
    });
    assert.equal(check.phase, 'recovery_required');
    assert.throws(() => f.checks.recover(check.id), /controller is still alive/);
    deadController(f);
    const path = join(check.receipt!.directory, 'completion.json');
    const original = readFileSync(path, 'utf8');
    const receipt = JSON.parse(original) as Record<string, unknown>;
    for (const mutation of [
      { token: 'wrong' },
      { checkId: 'wrong' },
      { exitConfirmed: false },
      { supervisorPid: process.pid },
      { toolPid: 0 },
    ]) {
      writeFileSync(path, JSON.stringify({ ...receipt, ...mutation }));
      assert.throws(() => f.checks.recover(check.id), /receipt|Supervisor/);
      assert.ok(f.store.lease(f.workspace.id));
    }
    writeFileSync(path, original);
    const recovered = f.checks.recover(check.id);
    assert.equal(recovered.phase, 'interrupted');
    assert.equal(recovered.result?.stdout, 'check passed\n');
    assert.equal(f.workflow.get(f.task.id).phase, 'running');
    assert.deepEqual(f.workflow.get(f.task.id).evidence, []);
    assert.equal((await f.checks.run(f.execution.id, await f.spec())).phase, 'passed');
  },
);

test('missing receipt after supervisor death cannot release ownership from dead PIDs alone', windows, async t => {
  const f = await fixture(t);
  let supervisor = 0;
  const check = await f.checks.run(f.execution.id, await f.spec('setInterval(()=>{},1000)'), undefined, async options =>
    runCheckProcess({
      ...options,
      started: (kind, pid) => {
        options.started(kind, pid);
        if (kind === 'supervisor') supervisor = pid;
        else process.kill(supervisor);
      },
    }),
  );
  assert.equal(check.phase, 'recovery_required');
  deadController(f);
  assert.throws(() => f.checks.recover(check.id), /ENOENT/);
  assert.ok(f.store.lease(f.workspace.id));
});

test('a crash before dispatch is recoverable from durable intent without inventing tool success', async t => {
  const f = await fixture(t);
  const spec = await f.spec();
  crashDuringInspection(
    f,
    `await checks.run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(spec)}, undefined, async () => { throw new Error('Unexpected dispatch'); });`,
  );
  const check = f.store.checks<RepositoryCheck>(f.execution.id).at(-1)!;
  assert.equal(check.dispatch, 'not_requested');
  assert.equal(check.receipt, undefined);
  assert.equal(f.checks.recover(check.id).phase, 'interrupted');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('read-only snapshot recovery is fenced and cannot release a command lease', async t => {
  const f = await fixture(t);
  crashDuringInspection(f, `await checks.snapshot(${JSON.stringify(f.execution.id)});`);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  execFileSync(process.execPath, [cli, 'execution-recover', f.execution.id, '--db', f.db], {
    windowsHide: true,
    stdio: 'pipe',
  });
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.equal(f.workflow.get(f.task.id).phase, 'running');
  const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async () => {
    throw new Error('Unknown tool');
  });
  assert.equal(check.phase, 'recovery_required');
  deadController(f);
  assert.throws(() => f.executions.recoverReadOnly(f.execution.id), /command and conversation/);
});

test('schema 6 migration preserves legacy uncertainty without inventing recovery evidence', async t => {
  const f = await fixture(t);
  const check = await f.checks.run(f.execution.id, await f.spec(), undefined, async () => {
    throw new Error('Unknown tool');
  });
  delete check.dispatch;
  delete check.receipt;
  delete check.purpose;
  f.store.saveCheck(check.id, f.execution.id, check);
  deadController(f);
  const db = new DatabaseSync(f.db);
  db.exec('PRAGMA user_version = 6');
  db.close();
  const migrated = new Store(f.db);
  try {
    assert.deepEqual(new Checks(migrated).get(check.id), check);
    assert.throws(() => new Checks(migrated).recover(check.id), /No durable dispatch/);
  } finally {
    migrated.close();
  }
});
