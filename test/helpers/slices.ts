// Shared fixtures for the slice tests: a multi-slice brief, gated execution and crash programs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/persistence/store.js';
import { Workflow, type Brief } from '../../src/domain/workflow.js';
import { Workspaces } from '../../src/repository/workspaces.js';
import { Executions } from '../../src/execution/executions.js';
import { Checks } from '../../src/verification/checks.js';
import { Deliveries } from '../../src/execution/deliveries.js';

export const windows = { skip: process.platform !== 'win32' };

export const brief: Brief = {
  title: 'Greeting library and CLI',
  outcome: 'Expose the greeting through a CLI',
  criteria: ['Library returns hello world', 'CLI prints hello world with a newline'],
  plan: 'Deliver the library, then the CLI and verify both together',
  slices: [
    { title: 'Library', plan: 'Update the library', criteria: ['Library returns hello world'] },
    { title: 'CLI', plan: 'Wire the CLI and inspect integration', criteria: ['CLI prints hello world with a newline'] },
  ],
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}

export const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export function invoke(db: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, '--db', db, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  });
}

export async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-slices-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.cjs'), "module.exports = 'hello';\n");
  writeFileSync(join(repo, 'cli.cjs'), "console.log('pending');\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Baseline');
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
  const execution = await executions.create(workspace.id, 1, 'codex');
  const checks = new Checks(store);
  const deliveries = new Deliveries(store);
  return { root, repo, db, store, workflow, task, workspace, executions, execution, checks, deliveries };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
