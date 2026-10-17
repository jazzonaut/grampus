import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from './store.js';
import type { Task } from './workflow.js';

export interface Workspace {
  id: string;
  taskId: string;
  version: number;
  adapter: 'git';
  repository: string;
  commonDirectory: string;
  path: string;
  branch: string;
  baseCommit: string;
  host: string;
  phase: 'creating' | 'ready' | 'recovery_required';
  owner: { controllerPid: number; gitPid: number | null; exitConfirmed: boolean } | null;
}

interface Worktree { path: string; head?: string; branch?: string; locked?: string }

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function contains(parent: string, child: string): boolean {
  const part = relative(pathKey(parent), pathKey(child));
  return part === '' || (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part));
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Never let an inherited Git directory/index override the explicitly chosen repository. */
function git(cwd: string, args: string[], started?: (pid: number | null) => void): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  return new Promise((resolveResult, reject) => {
    let startupError: unknown;
    const child = execFile('git', ['-C', cwd, ...args], { env, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (startupError) reject(startupError);
      else if (error) reject(new Error(`Git ${args[0]} failed (${error.code ?? error.signal ?? 'unknown'}); inspect workspace state before retrying`));
      else resolveResult(stdout);
    });
    child.stdin?.end();
    try { started?.(child.pid ?? null); }
    catch (error) { startupError = error; child.kill(); }
  });
}

async function worktrees(repository: string): Promise<Worktree[]> {
  const output = await git(repository, ['worktree', 'list', '--porcelain', '-z']);
  return output.split('\0\0').filter(Boolean).map(block => {
    const fields = Object.fromEntries(block.split('\0').filter(Boolean).map(field => {
      const space = field.indexOf(' ');
      return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
    }));
    if (!fields.worktree) throw new Error('Unrecognized Git worktree listing');
    return { path: exists(fields.worktree) ? realpathSync.native(fields.worktree) : fields.worktree, ...(fields.HEAD ? { head: fields.HEAD } : {}),
      ...(fields.branch ? { branch: fields.branch } : {}), ...(fields.locked !== undefined ? { locked: fields.locked } : {}) };
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Standalone worktrees only. The journal reserves a task/path before Git mutates anything. */
export class Workspaces {
  constructor(private readonly store: Store) {}
  get(id: string): Workspace { return this.store.workspace<Workspace>(id); }
  list(): Workspace[] { return this.store.workspaces<Workspace>(); }

  private change(id: string, type: string, action: (workspace: Workspace) => unknown): Workspace {
    return this.store.transaction(() => {
      const workspace = this.get(id);
      const data = action(workspace);
      this.store.saveWorkspace(id, workspace.taskId, pathKey(workspace.path), workspace);
      this.store.appendWorkspace(id, type, data ?? {});
      return workspace;
    });
  }

  private approved(taskId: string, version: number): Task {
    const task = this.store.get<Task>(taskId);
    if (task.version !== version || task.approvedVersion !== version || task.phase !== 'ready') {
      throw new Error('Workspace creation requires the exact approved version of a ready task');
    }
    if (task.synthetic) throw new Error('Synthetic tasks cannot create real workspaces');
    return task;
  }

  async create(taskId: string, version: number, repository: string, destination: string, base = 'HEAD'): Promise<Workspace> {
    this.approved(taskId, version);
    const root = realpathSync.native((await git(resolve(repository), ['rev-parse', '--show-toplevel'])).trim());
    const commonDirectory = realpathSync.native((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const target = resolve(destination);
    const parent = realpathSync.native(dirname(target));
    if (!statSync(parent).isDirectory()) throw new Error('Workspace parent must be a directory');
    const path = join(parent, basename(target));
    if (exists(path)) throw new Error('Workspace destination must not exist');
    const registered = await worktrees(root);
    if (contains(commonDirectory, path) || registered.some(item => contains(item.path, path))) {
      throw new Error('Workspace destination must be outside existing worktrees and Git metadata');
    }
    const baseCommit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
    const workspace: Workspace = { id: randomUUID(), taskId, version, adapter: 'git', repository: root,
      commonDirectory, path, branch: `grampus/${taskId}`, baseCommit, host: hostname(), phase: 'creating',
      owner: { controllerPid: process.pid, gitPid: null, exitConfirmed: false } };
    this.store.transaction(() => {
      this.approved(taskId, version);
      if (this.list().some(item => item.taskId === taskId || pathKey(item.path) === pathKey(path))) {
        throw new Error('Task or destination already has a workspace reservation; inspect or recover it');
      }
      this.store.saveWorkspace(workspace.id, taskId, pathKey(path), workspace);
      this.store.appendWorkspace(workspace.id, 'workspace.requested', workspace);
    });
    try {
      try {
        await git(root, ['worktree', 'add', '--lock', '--reason', `grampus:${workspace.id}`, '-b', workspace.branch, '--', path, baseCommit], pid => {
          this.change(workspace.id, 'git.started', current => { current.owner!.gitPid = pid; return { pid }; });
        });
      } finally {
        this.change(workspace.id, 'git.exited', current => { current.owner!.exitConfirmed = true; });
      }
      await this.verifyCreation(workspace);
      return this.change(workspace.id, 'workspace.ready', current => { current.phase = 'ready'; current.owner = null; });
    } catch (error) {
      this.change(workspace.id, 'workspace.recovery_required', current => {
        current.phase = 'recovery_required';
        return { reason: error instanceof Error ? error.message : String(error) };
      });
      throw new Error(`Workspace ${workspace.id} needs recovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async inspect(id: string): Promise<{ workspace: Workspace; head: string; dirty: boolean; taskCurrent: boolean }> {
    const workspace = this.get(id);
    if (workspace.host !== hostname()) throw new Error('Inspect this workspace on its execution host');
    const entry = (await worktrees(workspace.repository)).find(item => pathKey(item.path) === pathKey(workspace.path));
    if (!entry || entry.branch !== `refs/heads/${workspace.branch}` || entry.locked !== `grampus:${id}`) {
      throw new Error('Workspace registration, branch or ownership lock does not match');
    }
    const top = realpathSync.native((await git(workspace.path, ['rev-parse', '--show-toplevel'])).trim());
    const common = realpathSync.native((await git(workspace.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (pathKey(top) !== pathKey(workspace.path) || pathKey(common) !== pathKey(workspace.commonDirectory)) {
      throw new Error('Workspace repository identity does not match');
    }
    const head = (await git(workspace.path, ['rev-parse', '--verify', 'HEAD'])).trim();
    const dirty = (await git(workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])).length !== 0;
    const task = this.store.get<Task>(workspace.taskId);
    return { workspace, head, dirty, taskCurrent: task.version === workspace.version && task.approvedVersion === workspace.version };
  }

  private async verifyCreation(workspace: Workspace): Promise<void> {
    const inspected = await this.inspect(workspace.id);
    if (inspected.head !== workspace.baseCommit || inspected.dirty || !inspected.taskCurrent) {
      throw new Error('Created workspace must match the approved version and clean base commit');
    }
  }

  async recover(id: string): Promise<Workspace> {
    // Acquire ownership before any asynchronous inspection so a second reconciler cannot race.
    const workspace = this.change(id, 'recovery.requested', current => {
      if (current.phase === 'ready' || !current.owner) throw new Error('Workspace does not need recovery');
      if (current.host !== hostname()) throw new Error('Recover this workspace on its execution host');
      if (alive(current.owner.controllerPid) && current.owner.controllerPid !== process.pid) throw new Error('Previous workspace controller is alive or unverifiable');
      if (!current.owner.exitConfirmed && (current.owner.gitPid === null || alive(current.owner.gitPid))) {
        throw new Error('Git exit is unconfirmed; do not create a duplicate workspace');
      }
      if (current.phase === 'creating' && current.owner.controllerPid === process.pid) throw new Error('Workspace creation is still owned by this controller');
      current.phase = 'creating';
      current.owner = { controllerPid: process.pid, gitPid: null, exitConfirmed: true };
    });
    try {
      await this.verifyCreation(workspace);
      return this.change(id, 'workspace.recovered', current => {
        current.phase = 'ready'; current.owner = null; return { replayed: false };
      });
    } catch (error) {
      this.change(id, 'workspace.recovery_required', current => { current.phase = 'recovery_required'; return { reason: error instanceof Error ? error.message : String(error) }; });
      throw error;
    }
  }
}
