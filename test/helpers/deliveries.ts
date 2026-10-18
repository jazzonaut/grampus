// Shared fixtures for the delivery tests: gated repositories and controller crash programs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/persistence/store.js';
import { Workflow } from '../../src/domain/workflow.js';
import { Workspaces } from '../../src/repository/workspaces.js';
import { Executions } from '../../src/execution/executions.js';
import { Checks } from '../../src/verification/checks.js';
import { Deliveries } from '../../src/execution/deliveries.js';
import type { ExecutionLease } from '../../src/execution/execution-state.js';

export const windows = { skip: process.platform !== 'win32' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}

export async function fixture(t: { after(fn: () => void): void }, prepare?: (path: string) => void, noChange = false) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-delivery-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'obsolete.txt'), 'remove me\n');
  git(repo, 'add', '.');
  git(repo, 'update-index', '--chmod=+x', 'greeting.js');
  git(repo, 'commit', '-m', 'Baseline');
  const db = join(root, 'grampus.sqlite');
  const store = new Store(db);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workflow = new Workflow(store);
  const task = workflow.create({
    title: 'Delivery fixture',
    outcome: noChange ? 'Confirm existing greeting' : 'Update greeting',
    criteria: [noChange ? 'Print hello' : 'Print hello world'],
    plan: 'Fixture evidence for delivery tests',
  });
  workflow.approve(task.id, 1);
  const workspaces = new Workspaces(store);
  const workspace = await workspaces.create(task.id, 1, repo, join(root, 'workspace'));
  const execution = await new Executions(store).create(workspace.id, 1, 'codex');
  if (!noChange) {
    writeFileSync(join(workspace.path, 'greeting.js'), "console.log('hello world');\n");
    rmSync(join(workspace.path, 'obsolete.txt'));
    writeFileSync(join(workspace.path, 'new.bin'), Buffer.from([0, 255, 42]));
  }
  prepare?.(workspace.path);
  const checks = new Checks(store);
  const snapshot = await checks.snapshot(execution.id);
  if (noChange) {
    const validation = await checks.run(execution.id, {
      name: 'Check existing greeting',
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
      file: process.execPath,
      timeoutMs: 15000,
      args: [
        '-e',
        "const assert=require('node:assert/strict'); const {execFileSync}=require('node:child_process'); assert.equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello\\n');",
      ],
    });
    assert.equal(validation.phase, 'passed', JSON.stringify(validation));
    await checks.finish(execution.id, validation.id);
  } else
    workflow.finish(
      task.id,
      execution.attemptId,
      1,
      'succeeded',
      snapshot.artifact,
      'Explicit trusted fixture submission',
    );
  for (const kind of ['validation', 'simplification', 'review', 'verification'] as const) {
    if (noChange && kind === 'validation') continue;
    workflow.record(task.id, {
      id: kind,
      kind,
      artifact: snapshot.artifact,
      version: 1,
      attemptId: execution.attemptId,
      outcome: 'passed',
      source: 'controller',
      summary: 'Trusted test fixture evidence; no live inference',
      criteria: task.brief.criteria,
      ...(kind === 'review'
        ? { agent: { provider: 'claude' as const, model: 'fixture', sessionId: 'fixture-review' } }
        : {}),
    });
  }
  const deliveries = new Deliveries(store);
  const spec = {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    message: 'Update greeting',
    timeoutMs: 15_000,
  };
  return { root, repo, db, store, workflow, task, workspace, execution, snapshot, deliveries, spec };
}

export async function noChangeFixture(t: { after(fn: () => void): void }, prepare?: (path: string) => void) {
  const f = await fixture(t, prepare, true);
  return {
    ...f,
    spec: { ...f.spec, mode: 'no_change' as const, message: 'Existing greeting already satisfies the approved task' },
  };
}

export function deadController(f: Awaited<ReturnType<typeof fixture>>): void {
  const pid = Number(
    execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }),
  );
  const lease = f.store.lease<ExecutionLease>(f.workspace.id)!;
  f.store.transaction(() => {
    f.store.releaseLease(f.workspace.id, f.execution.id, lease.runId);
    f.store.acquireLease(f.workspace.id, f.execution.id, lease.runId, { ...lease, controllerPid: pid });
  });
}

export function crash(f: Awaited<ReturnType<typeof fixture>>, beforeDispatch: boolean): void {
  const url = (name: string) => JSON.stringify(new URL(`../../src/${name}.js`, import.meta.url).href);
  const code = `import {Store} from ${url('persistence/store')}; import {Deliveries} from ${url('execution/deliveries')}; import {Workspaces} from ${url('repository/workspaces')}; import {runCheckProcess} from ${url('process/check-process')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    ${beforeDispatch ? 'workspaces.inspect = async () => process.exit(0);' : ''}
    await new Deliveries(store, workspaces).run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(f.spec)}, undefined,
      async options => { await runCheckProcess(options); process.exit(0); });`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'pipe' });
}
