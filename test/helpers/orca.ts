// Shared fixtures for the Orca tests: a fake Orca runtime and repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/persistence/store.js';
import { Workflow, type Brief } from '../../src/domain/workflow.js';
import { Workspaces } from '../../src/repository/workspaces.js';
import { OrcaCli, type OrcaTransport } from '../../src/repository/orca.js';
import { Executions } from '../../src/execution/executions.js';
import { Checks } from '../../src/verification/checks.js';
import { Implementations } from '../../src/execution/implementations.js';
import { Deliveries } from '../../src/execution/deliveries.js';
import { runCheckProcess, type CheckProcessOptions } from '../../src/process/check-process.js';

export const brief = {
  title: 'Orca fixture',
  outcome: 'Isolate checkout',
  criteria: ['Base preserved'],
  plan: 'Create then inspect',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function fixture(t: { after(fn: () => void): void }, taskBrief: Brief = brief) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-orca-test-'));
  const repo = join(root, 'source');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Fixture');
  const db = join(root, 'grampus.sqlite');
  const store = new Store(db);
  const workflow = new Workflow(store);
  const task = workflow.create(taskBrief);
  workflow.approve(task.id, 1);
  const requests: string[][] = [];
  const state: {
    worktree: Record<string, unknown> | null;
    loseReply: boolean;
    truncated: boolean;
    duplicate: boolean;
    empty: boolean;
    old: boolean;
  } = { worktree: null, loseReply: false, truncated: false, duplicate: false, empty: false, old: false };
  const run: OrcaTransport = async (_cwd, args) => {
    requests.push(args);
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const response = (result: unknown) => JSON.stringify({ ok: true, result });
    if (args.includes('--help')) return state.old ? '--json' : '--setup --no-parent --base-branch --comment --json';
    if (args[0] === 'repo') return response({ repo: { id: 'fixture-repo', path: repo, kind: 'git' } });
    if (args[1] === 'create') {
      // Simulate Orca's host, including its own path/branch naming. Production only calls the CLI.
      const name = value('--name');
      const path = join(root, name);
      const branch = `fixture/${name}`;
      git(repo, 'worktree', 'add', '-b', branch, path, value('--base-branch'));
      state.worktree = {
        id: `fixture-repo::${path}`,
        repoId: 'fixture-repo',
        path,
        branch: `refs/heads/${branch}`,
        hostId: 'local',
        instanceId: 'instance-a',
        identity: { key: 'wt2:local:instance-a', instanceId: 'instance-a', executionHostId: 'local' },
        displayName: name,
        comment: value('--comment'),
        baseRef: value('--base-branch'),
        isMainWorktree: false,
        isArchived: false,
      };
      if (state.loseReply) throw new Error('Fixture lost response');
      return response({ worktree: state.worktree });
    }
    if (args[1] === 'list') {
      const entries =
        state.worktree && !state.empty ? (state.duplicate ? [state.worktree, state.worktree] : [state.worktree]) : [];
      return response({
        worktrees: entries,
        truncated: state.truncated,
        totalCount: entries.length,
        hostScope: { hostIds: ['local'], omittedHostIds: [] },
      });
    }
    if (args[1] === 'show') return response({ worktree: state.worktree });
    throw new Error('Unexpected fixture command');
  };
  const client = new OrcaCli(run);
  const workspaces = new Workspaces(store, client);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, db, store, workflow, task, workspaces, client, state, requests };
}

export const windows = { skip: process.platform !== 'win32' };

export async function implementationFixture(
  t: { after(fn: () => void): void },
  provider: 'claude' | 'codex' = 'codex',
  taskBrief: Brief = brief,
) {
  const f = fixture(t, taskBrief);
  const workspace = await f.workspaces.createOrca(f.task.id, 1, f.repo, 'main');
  const execution = await new Executions(f.store, f.workspaces).create(workspace.id, 1, provider);
  const checks = new Checks(f.store, f.workspaces);
  const snapshot = await checks.snapshot(execution.id);
  const policy = {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    files: ['greeting.txt'],
  };
  return {
    ...f,
    workspace,
    execution,
    checks,
    snapshot,
    policy,
    implementations: new Implementations(f.store, f.workspaces),
  };
}

export async function deliveryFixture(t: { after(fn: () => void): void }, noChange = false, taskBrief: Brief = brief) {
  const f = await implementationFixture(t, 'codex', taskBrief);
  if (!noChange) writeFileSync(join(f.workspace.path, 'greeting.txt'), 'hello world\n');
  const snapshot = await f.checks.snapshot(f.execution.id);
  f.workflow.finish(f.task.id, f.execution.attemptId, 1, 'succeeded', snapshot.artifact, 'Trusted fixture submission');
  for (const kind of ['validation', 'quality', 'review', 'verification'] as const)
    f.workflow.record(f.task.id, {
      id: kind,
      kind,
      ...(kind === 'quality' ? { pass: 'simplification' } : {}),
      artifact: snapshot.artifact,
      version: 1,
      attemptId: f.execution.attemptId,
      outcome: 'passed',
      source: 'controller',
      summary: 'Offline fixture gates; no live inference',
      criteria: f.task.brief.criteria,
      ...(kind === 'review'
        ? { agent: { provider: 'claude' as const, model: 'fixture', sessionId: 'independent-fixture' } }
        : {}),
    });
  return {
    ...f,
    snapshot,
    deliveries: new Deliveries(f.store, f.workspaces),
    spec: {
      artifact: snapshot.artifact,
      instructionsDigest: snapshot.instructionsDigest,
      message: 'Deliver Orca fixture',
      timeoutMs: 15000,
    },
  };
}

// Simulate only Orca's identity RPC. The real writer still runs inside the Job Object.
export async function supervisedOrcaWriter(
  f: Awaited<ReturnType<typeof deliveryFixture>>,
  options: CheckProcessOptions,
) {
  const identityFile = join(f.root, 'orca-identity.json');
  writeFileSync(identityFile, JSON.stringify(f.state.worktree));
  const url = (name: string) => JSON.stringify(new URL(`../../src/${name}.js`, import.meta.url).href);
  const script = `import {readFileSync} from 'node:fs'; import {deliverRepository} from ${url('execution/delivery-operation')};
    import {Workspaces} from ${url('repository/workspaces')}; import {OrcaCli} from ${url('repository/orca')};
    const request=JSON.parse(readFileSync(process.argv[1],'utf8'));
    const client=new OrcaCli(async()=>JSON.stringify({ok:true,result:{worktree:JSON.parse(readFileSync(process.argv[2],'utf8'))}}));
    console.log(await deliverRepository(request,process.argv[1]+'.message',store=>new Workspaces(store,client)));`;
  return runCheckProcess({
    ...options,
    args: ['--input-type=module', '-e', script, options.args.at(-1)!, identityFile],
  });
}
