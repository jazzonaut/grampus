// Shared fixtures for the implementation tests: an editable repository and fake provider results.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/persistence/store.js';
import { Workflow } from '../../src/domain/workflow.js';
import { Workspaces } from '../../src/repository/workspaces.js';
import { Executions } from '../../src/execution/executions.js';
import { Checks } from '../../src/verification/checks.js';
import { Implementations } from '../../src/execution/implementations.js';
import type { EditPolicy } from '../../src/execution/edit-policy.js';
import type { CheckProcessOptions } from '../../src/process/check-process.js';
import type { Reply } from '../../src/providers/types.js';

export const windows = { skip: process.platform !== 'win32' };

export const reply: Reply = { kind: 'message', text: 'Fixture edit complete', questions: [], findings: [] };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}

export async function fixture(t: { after(fn: () => void): void }, provider: 'claude' | 'codex' = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'grampus-edit-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'other.txt'), 'unchanged\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Use one direct output statement.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Baseline');
  const db = join(root, 'grampus.sqlite');
  const store = new Store(db);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workflow = new Workflow(store);
  const task = workflow.create({
    title: 'Greeting',
    outcome: 'Print hello world',
    criteria: ['Print hello world'],
    plan: 'Edit greeting, check and review',
  });
  workflow.approve(task.id, 1);
  const workspace = await new Workspaces(store).create(task.id, 1, repo, join(root, 'workspace'));
  const execution = await new Executions(store).create(workspace.id, 1, provider);
  const checks = new Checks(store);
  const snapshot = await checks.snapshot(execution.id);
  const policy: EditPolicy = {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    files: ['greeting.js'],
  };
  const context = { cwd: workspace.path, policy, snapshot };
  return {
    root,
    repo,
    db,
    store,
    workflow,
    task,
    workspace,
    execution,
    checks,
    snapshot,
    policy,
    context,
    implementations: new Implementations(store),
  };
}

export function fakeResult(options: CheckProcessOptions, value = reply) {
  writeFileSync(
    join(options.receipt!.directory, 'result.json'),
    JSON.stringify({
      id: options.receipt!.checkId,
      result: { status: 'completed', reply: value, usage: null, error: null },
    }),
  );
  return { reason: 'exited', exitCode: 0, exitConfirmed: true, stdout: '', stderr: '', outputTruncated: false };
}
