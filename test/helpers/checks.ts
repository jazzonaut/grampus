// Shared fixtures for the check tests: a gated repository, process probes and crash programs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { Workflow } from '../../src/workflow.js';
import { Workspaces } from '../../src/workspaces.js';
import { Executions } from '../../src/executions.js';
import { Checks, type CheckSpec } from '../../src/checks.js';
import type { ExecutionLease } from '../../src/execution-state.js';

export const windows = { skip: process.platform !== 'win32' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-check-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'AGENTS.md'), 'Check the greeting output.\n');
  writeFileSync(join(repo, '.gitignore'), 'generated/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Fixture baseline');
  const db = join(root, 'journal.sqlite');
  const store = new Store(db);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workflow = new Workflow(store);
  const task = workflow.create({
    title: 'Greeting',
    outcome: 'Print hello',
    criteria: ['Print hello'],
    plan: 'Implement and check',
  });
  workflow.approve(task.id, 1);
  const workspaces = new Workspaces(store);
  const workspace = await workspaces.create(task.id, 1, repo, join(root, 'workspace'));
  const executions = new Executions(store);
  const execution = await executions.create(workspace.id, 1, 'codex');
  const checks = new Checks(store);
  const spec = async (code = "console.log('check passed')"): Promise<CheckSpec> => {
    const snapshot = await checks.snapshot(execution.id);
    return {
      name: 'Fixture check',
      file: process.execPath,
      args: ['-e', code],
      timeoutMs: 5000,
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
    };
  };
  return { root, repo, db, store, task, workflow, workspace, workspaces, execution, executions, checks, spec };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function deadController(f: Awaited<ReturnType<typeof fixture>>): void {
  const pid = Number(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(alive(pid), false);
  f.store.transaction(() => {
    const lease = f.store.lease<ExecutionLease>(f.workspace.id)!;
    f.store.releaseLease(f.workspace.id, lease.executionId, lease.runId);
    f.store.acquireLease(f.workspace.id, lease.executionId, lease.runId, { ...lease, controllerPid: pid });
  });
}

export function crashDuringInspection(f: Awaited<ReturnType<typeof fixture>>, operation: string): void {
  const url = (name: string) => JSON.stringify(new URL(`../../src/${name}.js`, import.meta.url).href);
  const code = `import {Store} from ${url('store')}; import {Checks} from ${url('checks')}; import {Workspaces} from ${url('workspaces')};
    const store = new Store(${JSON.stringify(f.db)}); const workspaces = new Workspaces(store);
    workspaces.inspect = async () => process.exit(0); const checks = new Checks(store, workspaces); ${operation}`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'pipe' });
}
