import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Store } from '../persistence/store.js';
import type { Workspace } from '../persistence/records.js';
import type { Task } from '../domain/workflow.js';
import { OrcaCli, type OrcaWorkspaceClient, type OrcaWorktree } from './orca.js';
import { currentProcessStartedAt, inspectProcess } from '../process/process-identity.js';
import { processAlive } from '../verification/check-recovery.js';
import { processLimits } from '../config/limits.js';
import { worktreeList } from './git-output.js';
import { systemErrorCode } from '../process/boundary.js';

export type { Workspace } from '../persistence/records.js';

type LocatedWorkspace = Workspace & { path: string; branch: string };

/** A workspace that has been placed: it has a path and a branch. */
function located(workspace: Workspace): LocatedWorkspace {
  const { path, branch } = workspace;
  if (!path || !branch) throw new Error('Workspace has no path or branch');
  return { ...workspace, path, branch };
}
/** The creation owner recorded before any Git or Orca call. */
function creationOwner(workspace: Workspace): NonNullable<Workspace['owner']> {
  if (!workspace.owner) throw new Error('Workspace creation has no recorded owner');
  return workspace.owner;
}
function orcaReservation(workspace: Workspace): NonNullable<Workspace['orca']> {
  if (!workspace.orca) throw new Error('Workspace has no Orca reservation');
  return workspace.orca;
}

function reservationKey(workspace: Workspace): string {
  if (workspace.phase === 'released') return `released:${workspace.id}`;
  if (workspace.path) return pathKey(workspace.path);
  if (!workspace.orca) throw new Error('Workspace has no destination or Orca reservation');
  return `orca:${workspace.orca.repoId}:${workspace.orca.name}`;
}

interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  locked?: string;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function contains(parent: string, child: string): boolean {
  const part = relative(pathKey(parent), pathKey(child));
  return (
    part === '' ||
    (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part))
  );
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Never let an inherited Git directory/index override the explicitly chosen repository. */
function git(cwd: string, args: string[], started?: (pid: number | null) => void): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  return new Promise((resolveResult, reject) => {
    let startupError: unknown;
    const creating = args[0] === 'worktree' && args[1] === 'add';
    const timeout = creating ? processLimits.worktreeCreateTimeoutMs : processLimits.gitTimeoutMs;
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...(creating ? ['-c', 'core.autocrlf=false'] : []), '-C', cwd, ...args],
      { env, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: processLimits.toolOutputBytes },
      (error, stdout) => {
        if (startupError)
          reject(
            startupError instanceof Error ? startupError : new Error('Git could not start', { cause: startupError }),
          );
        else if (error)
          reject(
            new Error(
              `Git ${args[0]} failed (${error.code ?? error.signal ?? 'unknown'}); inspect workspace state before retrying`,
            ),
          );
        else resolveResult(stdout);
      },
    );
    child.stdin?.end();
    try {
      started?.(child.pid ?? null);
    } catch (error) {
      startupError = error;
      child.kill();
    }
  });
}

async function worktrees(repository: string): Promise<Worktree[]> {
  const output = await git(repository, ['worktree', 'list', '--porcelain', '-z']);
  return worktreeList(output).map(entry => ({
    path: exists(entry.worktree) ? realpathSync.native(entry.worktree) : entry.worktree,
    ...(entry.HEAD ? { head: entry.HEAD } : {}),
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.locked !== undefined ? { locked: entry.locked } : {}),
  }));
}

/** Journal intent before asking Git or Orca to create a worktree; never replay creation. */
export class Workspaces {
  constructor(
    private readonly store: Store,
    private readonly orca: OrcaWorkspaceClient = new OrcaCli(),
  ) {}
  get(id: string): Workspace {
    return this.store.workspace(id);
  }
  /** The checked-out path of a workspace; a reservation that has none cannot run work. */
  path(id: string): string {
    const { path } = this.get(id);
    if (!path) throw new Error('Workspace has no checked-out path');
    return path;
  }
  list(): Workspace[] {
    return this.store.workspaces();
  }

  /** Metadata only: a reviewed revision keeps the original base, branch and files. */
  rebind(id: string, previousVersion: number): Workspace {
    return this.change(id, 'workspace.version_rebound', workspace => {
      const task = this.store.get<Task>(workspace.taskId);
      if (
        workspace.phase !== 'ready' ||
        workspace.owner ||
        this.store.lease(id) ||
        workspace.version !== previousVersion ||
        task.version !== previousVersion + 1 ||
        task.phase !== 'draft' ||
        task.approvedVersion !== null ||
        task.guided?.workspaceId !== id ||
        task.guided.plan.revision?.previousVersion !== previousVersion
      ) {
        throw new Error('Workspace rebinding requires a settled guided revision awaiting approval');
      }
      workspace.version = task.version;
      return { previousVersion, version: task.version, preserved: 'Original base, branch, files and commits' };
    });
  }

  private change(id: string, type: string, action: (workspace: Workspace) => unknown): Workspace {
    return this.store.transaction(() => {
      const workspace = this.get(id);
      const data = action(workspace);
      this.store.saveWorkspace(id, workspace.taskId, reservationKey(workspace), workspace);
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

  async create(
    taskId: string,
    version: number,
    repository: string,
    destination: string,
    base = 'HEAD',
  ): Promise<LocatedWorkspace> {
    this.approved(taskId, version);
    const root = realpathSync.native((await git(resolve(repository), ['rev-parse', '--show-toplevel'])).trim());
    const commonDirectory = realpathSync.native(
      (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
    );
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
    const released = this.list().find(item => item.taskId === taskId && item.phase === 'released');
    const workspace: LocatedWorkspace = {
      id: released?.id ?? randomUUID(),
      taskId,
      version,
      adapter: 'git',
      repository: root,
      commonDirectory,
      path,
      branch: released ? `grampus/${taskId}-${randomUUID()}` : `grampus/${taskId}`,
      baseCommit,
      host: hostname(),
      phase: 'creating',
      owner: {
        controllerPid: process.pid,
        controllerStartedAt: currentProcessStartedAt(),
        gitPid: null,
        gitStartedAt: null,
        exitConfirmed: false,
      },
    };
    this.store.transaction(() => {
      this.approved(taskId, version);
      if (
        this.list().some(
          item =>
            item.phase !== 'released' &&
            (item.taskId === taskId || (item.path && pathKey(item.path) === pathKey(path))),
        ) ||
        (released && this.get(released.id).phase !== 'released')
      ) {
        throw new Error('Task or destination already has a workspace reservation; inspect or recover it');
      }
      this.store.saveWorkspace(workspace.id, taskId, pathKey(path), workspace);
      this.store.appendWorkspace(workspace.id, 'workspace.requested', workspace);
    });
    try {
      try {
        await git(
          root,
          [
            'worktree',
            'add',
            '--lock',
            '--reason',
            `grampus:${workspace.id}`,
            '-b',
            workspace.branch,
            '--',
            path,
            baseCommit,
          ],
          pid => {
            // Observed before the write lock: the query starts PowerShell, which would hold up other tasks.
            const observed = pid === null ? null : inspectProcess(pid);
            this.change(workspace.id, 'git.started', current => {
              const owner = creationOwner(current);
              owner.gitPid = pid;
              owner.gitStartedAt = observed?.state === 'present' ? observed.startedAt : null;
              return { pid, startedAt: owner.gitStartedAt };
            });
          },
        );
      } finally {
        this.change(workspace.id, 'git.exited', current => {
          creationOwner(current).exitConfirmed = true;
        });
      }
      await this.verifyCreation(workspace);
      return located(
        this.change(workspace.id, 'workspace.ready', current => {
          current.phase = 'ready';
          current.owner = null;
        }),
      );
    } catch (error) {
      this.change(workspace.id, 'workspace.recovery_required', current => {
        current.phase = 'recovery_required';
        return { reason: error instanceof Error ? error.message : String(error) };
      });
      throw new Error(
        `Workspace ${workspace.id} needs recovery: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Release only a proved-unused standalone reservation. Never remove files, branches or worktrees. */
  async release(id: string): Promise<Workspace> {
    const workspace = this.change(id, 'workspace.release_requested', current => {
      if (
        current.adapter !== 'git' ||
        current.phase !== 'recovery_required' ||
        !current.owner?.exitConfirmed ||
        current.host !== hostname() ||
        !current.path ||
        this.store.lease(id) ||
        this.store.executions().some(execution => execution.workspaceId === id)
      )
        throw new Error('Only an unused standalone reservation with confirmed Git exit can be released');
      if (
        current.owner.controllerPid !== process.pid &&
        processAlive(current.owner.controllerPid, current.owner.controllerStartedAt)
      )
        throw new Error('Previous workspace controller is alive or unverifiable');
      const task = this.store.get<Task>(current.taskId);
      if (task.guided?.owner && (task.guided.owner.controllerPid !== process.pid || task.guided.stage !== 'workspace'))
        throw new Error('Reconcile the guided controller before releasing its reservation');
      current.phase = 'creating';
      current.owner = {
        controllerPid: process.pid,
        controllerStartedAt: currentProcessStartedAt(),
        gitPid: null,
        gitStartedAt: null,
        exitConfirmed: true,
      };
    });
    try {
      const path = workspace.path;
      if (
        !path ||
        exists(path) ||
        (await worktrees(workspace.repository)).some(item => pathKey(item.path) === pathKey(path))
      )
        throw new Error('Workspace files or Git registration exist; inspect or recover them instead of releasing');
      return this.change(id, 'workspace.released', current => {
        if (
          current.phase !== 'creating' ||
          current.owner?.controllerPid !== process.pid ||
          current.path !== path ||
          exists(path)
        )
          throw new Error('Workspace changed during release');
        current.phase = 'released';
        current.owner = null;
        return { retained: 'All files, branches and journal history; no Git mutation', creationReplayed: false };
      });
    } catch (error) {
      this.change(id, 'workspace.release_refused', current => {
        current.phase = 'recovery_required';
        return { reason: error instanceof Error ? error.message : String(error) };
      });
      throw error;
    }
  }

  async createOrca(taskId: string, version: number, repository: string, base: string): Promise<LocatedWorkspace> {
    this.approved(taskId, version);
    if (!base.trim()) throw new Error('Orca creation requires an explicit base ref');
    const root = realpathSync.native((await git(resolve(repository), ['rev-parse', '--show-toplevel'])).trim());
    const commonDirectory = realpathSync.native(
      (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
    );
    const repo = await this.orca.preflight(root);
    const orcaCommon = realpathSync.native(
      (await git(repo.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
    );
    if (pathKey(commonDirectory) !== pathKey(orcaCommon))
      throw new Error('Orca repository does not match the requested Git repository');
    const baseCommit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
    const released = this.list().find(item => item.taskId === taskId && item.phase === 'released');
    const id = released?.id ?? randomUUID();
    const workspace: Workspace = {
      id,
      taskId,
      version,
      adapter: 'orca',
      repository: root,
      commonDirectory,
      path: null,
      branch: null,
      baseCommit,
      host: hostname(),
      phase: 'creating',
      owner: {
        controllerPid: process.pid,
        controllerStartedAt: currentProcessStartedAt(),
        gitPid: null,
        gitStartedAt: null,
        exitConfirmed: false,
      },
      orca: {
        repoId: repo.id,
        name: `grampus-${id}`,
        marker: `grampus-workspace:${id}`,
        identityKey: null,
        instanceId: null,
        worktreeId: null,
      },
    };
    this.store.transaction(() => {
      this.approved(taskId, version);
      if (
        this.list().some(item => item.taskId === taskId && item.phase !== 'released') ||
        (released && this.get(released.id).phase !== 'released')
      )
        throw new Error('Task already has a workspace reservation; inspect or recover it');
      this.store.saveWorkspace(id, taskId, reservationKey(workspace), workspace);
      this.store.appendWorkspace(id, 'workspace.requested', workspace);
    });
    try {
      const result = await this.orca.create(root, {
        repoId: repo.id,
        name: orcaReservation(workspace).name,
        marker: orcaReservation(workspace).marker,
        baseCommit,
      });
      this.bindOrca(id, result);
      await this.verifyCreation(this.get(id));
      return located(
        this.change(id, 'workspace.ready', current => {
          current.phase = 'ready';
          current.owner = null;
        }),
      );
    } catch (error) {
      this.change(id, 'workspace.recovery_required', current => {
        current.phase = 'recovery_required';
        return { reason: error instanceof Error ? error.message : String(error), replayed: false };
      });
      throw new Error(
        `Workspace ${id} needs recovery; Orca creation must not be replayed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private bindOrca(id: string, result: OrcaWorktree): void {
    this.change(id, 'orca.identity_recorded', current => {
      const orca = orcaReservation(current);
      if (
        result.repoId !== orca.repoId ||
        result.name !== orca.name ||
        result.comment !== orca.marker ||
        result.baseRef !== current.baseCommit ||
        result.isMain ||
        result.archived
      )
        throw new Error('Orca result does not match the workspace request');
      if (
        orca.identityKey &&
        (orca.identityKey !== result.identityKey ||
          orca.instanceId !== result.instanceId ||
          orca.worktreeId !== result.id)
      ) {
        throw new Error('Orca workspace instance changed');
      }
      const path = realpathSync.native(result.path);
      if (contains(current.repository, path) || contains(current.commonDirectory, path))
        throw new Error('Orca returned a nested workspace');
      current.path = path;
      current.branch = result.branch.slice('refs/heads/'.length);
      orca.identityKey = result.identityKey;
      orca.instanceId = result.instanceId;
      orca.worktreeId = result.id;
      return { identityKey: result.identityKey, worktreeId: result.id };
    });
  }

  async inspect(
    id: string,
    includeStatus = true,
  ): Promise<{ workspace: Workspace; head: string; dirty: boolean | null; taskCurrent: boolean }> {
    const workspace = this.get(id);
    if (workspace.phase === 'released')
      throw new Error('This reservation was released; explicitly create a new workspace');
    if (workspace.host !== hostname()) throw new Error('Inspect this workspace on its execution host');
    if (!workspace.path || !workspace.branch)
      throw new Error('Workspace destination is unknown; recover its Orca identity first');
    if (workspace.adapter === 'orca') {
      const orca = workspace.orca;
      if (!orca?.identityKey) throw new Error('Orca workspace identity is unknown');
      const result = await this.orca.show(workspace.repository, orca.identityKey);
      if (
        result.identityKey !== orca.identityKey ||
        result.instanceId !== orca.instanceId ||
        result.id !== orca.worktreeId ||
        result.repoId !== orca.repoId ||
        result.isMain ||
        result.archived ||
        pathKey(realpathSync.native(result.path)) !== pathKey(workspace.path) ||
        result.branch !== `refs/heads/${workspace.branch}`
      ) {
        throw new Error('Orca workspace instance, repository or branch changed');
      }
    }
    const workspacePath = workspace.path;
    const entry = (await worktrees(workspace.repository)).find(item => pathKey(item.path) === pathKey(workspacePath));
    if (
      !entry ||
      entry.branch !== `refs/heads/${workspace.branch}` ||
      (workspace.adapter === 'git' && entry.locked !== `grampus:${id}`)
    ) {
      throw new Error('Workspace registration, branch or ownership lock does not match');
    }
    const top = realpathSync.native((await git(workspace.path, ['rev-parse', '--show-toplevel'])).trim());
    const common = realpathSync.native(
      (await git(workspace.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
    );
    if (pathKey(top) !== pathKey(workspace.path) || pathKey(common) !== pathKey(workspace.commonDirectory)) {
      throw new Error('Workspace repository identity does not match');
    }
    const head = (await git(workspace.path, ['rev-parse', '--verify', 'HEAD'])).trim();
    const dirty = includeStatus
      ? (await git(workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])).length !== 0
      : null;
    const task = this.store.get<Task>(workspace.taskId);
    return {
      workspace,
      head,
      dirty,
      taskCurrent: task.version === workspace.version && task.approvedVersion === workspace.version,
    };
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
      const controllerAlive = processAlive(current.owner.controllerPid, current.owner.controllerStartedAt);
      if (controllerAlive && current.owner.controllerPid !== process.pid)
        throw new Error('Previous workspace controller is alive or unverifiable');
      if (
        current.adapter === 'git' &&
        !current.owner.exitConfirmed &&
        (current.owner.gitPid === null || processAlive(current.owner.gitPid, current.owner.gitStartedAt))
      ) {
        throw new Error('Git exit is unconfirmed; do not create a duplicate workspace');
      }
      if (current.phase === 'creating' && current.owner.controllerPid === process.pid && controllerAlive)
        throw new Error('Workspace creation is still owned by this controller');
      current.phase = 'creating';
      current.owner = {
        controllerPid: process.pid,
        controllerStartedAt: currentProcessStartedAt(),
        gitPid: null,
        gitStartedAt: null,
        exitConfirmed: current.adapter === 'git',
      };
    });
    try {
      if (workspace.adapter === 'orca' && !workspace.orca?.identityKey) {
        const orca = orcaReservation(workspace);
        const matches = (await this.orca.list(workspace.repository, orca.repoId)).filter(
          item => item.name === orca.name && item.comment === orca.marker,
        );
        const [match] = matches;
        if (matches.length !== 1 || !match)
          throw new Error('Orca creation outcome is unknown or ambiguous; reservation retained without replay');
        this.bindOrca(id, match);
      }
      await this.verifyCreation(this.get(id));
      return this.change(id, 'workspace.recovered', current => {
        current.phase = 'ready';
        current.owner = null;
        return { replayed: false };
      });
    } catch (error) {
      this.change(id, 'workspace.recovery_required', current => {
        current.phase = 'recovery_required';
        return { reason: error instanceof Error ? error.message : String(error) };
      });
      throw error;
    }
  }
}
