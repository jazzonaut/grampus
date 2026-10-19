// Projects journal facts onto Orca cards while the dashboard is open. This is a disposable view:
// failures never change a task, acquire an execution lease or establish completion evidence.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { orcaPresentationLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import type { Task } from '../domain/workflow.js';
import type { Stage } from '../orchestration/guided/state.js';
import type { Workspace } from '../persistence/records.js';
import type { Store } from '../persistence/store.js';
import type { OrcaCard, OrcaDesktopClient, OrcaWorktree } from './orca.js';

const stages: Record<Stage, string> = {
  workspace: 'Preparing workspace',
  execution: 'Starting attempt',
  preparation: 'Preparing repository',
  scope: 'Inspecting file scope',
  implementation: 'Implementing',
  quality_pass: 'Quality pass',
  refresh: 'Inspecting changes',
  validation: 'Running checks',
  submission: 'Submitting changes',
  assessment: 'Assessing quality',
  review_execution: 'Preparing independent review',
  review: 'Independent review',
  verification: 'Checking acceptance',
  delivery: 'Delivering locally',
  complete: 'Completion unconfirmed',
};

const boundedText = (text: string, length: number) =>
  text
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .trim()
    .slice(0, length);
const pathKey = (path: string) => {
  const absolute = resolve(realpathSync.native(path));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

/** The desktop's last observed projection failure, separate from task and provider health. */
export interface OrcaPresentationStatus {
  problem: string | null;
}

/** A card derived solely from the journal. A complete guided status alone is insufficient. */
export function orcaCard(task: Task): OrcaCard {
  const state = task.guided;
  if (!state) throw new Error('Orca presentation requires a guided task');
  const complete =
    state.status === 'complete' &&
    state.stage === 'complete' &&
    task.phase === 'complete' &&
    task.version === state.version &&
    task.approvedVersion === state.version &&
    state.approvedDigest === state.digest &&
    !state.pending &&
    !state.owner;
  const attention = !complete && (state.stopReason !== null || !['ready', 'running'].includes(state.status));
  const label = complete ? 'Delivered locally' : (state.stopReason?.message ?? stages[state.stage]);
  return {
    title: boundedText(task.brief.title, orcaPresentationLimits.titleCharacters),
    comment: boundedText(
      `Grampus: ${label} (slice ${state.sliceIndex + 1}/${state.plan.slices.length})`,
      orcaPresentationLimits.commentCharacters,
    ),
    status: complete
      ? 'completed'
      : attention
        ? 'todo'
        : ['assessment', 'review_execution', 'review', 'verification'].includes(state.stage)
          ? 'in-review'
          : 'in-progress',
    attention,
  };
}

/** Exact instance and checkout binding, shared by card updates and explicit workspace navigation. */
function sameWorkspace(workspace: Workspace, observed: OrcaWorktree): boolean {
  return (
    observed.identityKey === workspace.orca?.identityKey &&
    observed.instanceId === workspace.orca.instanceId &&
    observed.id === workspace.orca.worktreeId &&
    observed.repoId === workspace.orca.repoId &&
    !observed.isMain &&
    !observed.archived &&
    workspace.path !== null &&
    pathKey(observed.path) === pathKey(workspace.path) &&
    observed.branch === `refs/heads/${workspace.branch}`
  );
}

/** Serial, best-effort desktop updates. Only ready, bound workspaces are eligible; creation markers stay intact until adoption. */
export class OrcaPresentation {
  private readonly applied = new Map<string, string>();
  private readonly statuses = new Map<string, OrcaPresentationStatus>();
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly client: OrcaDesktopClient,
  ) {}

  /** Starts observations without blocking the dashboard or overlapping a preceding scan. */
  start(): void {
    if (this.timer || this.closed) return;
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, currentSettings().orcaSyncIntervalMs);
    this.timer.unref();
  }

  /** Observes every eligible workspace once. Failed display writes may be retried; provider and Git operations never are. */
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.active ??= this.scan()
      .catch(() => {
        /* A refused journal read leaves the desktop unchanged. */
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }

  /** A projection problem is shown on its task page, without changing workflow state. */
  status(id: string): OrcaPresentationStatus {
    return this.statuses.get(id) ?? { problem: null };
  }

  private snapshot(workspace: Workspace) {
    const task = this.store.get(workspace.taskId);
    if (
      task.deletedAt ||
      !task.guided ||
      task.guided.workspaceId !== workspace.id ||
      workspace.phase !== 'ready' ||
      workspace.adapter !== 'orca' ||
      !workspace.orca?.identityKey
    )
      return null;
    const card = orcaCard(task);
    const key = JSON.stringify([workspace, card, task.version, task.guided.stopReason?.at]);
    return { task, workspace, card, key, identity: workspace.orca.identityKey };
  }

  private async scan(): Promise<void> {
    for (const workspace of this.store.workspaces()) {
      if (this.closed) return;
      if (workspace.adapter !== 'orca') continue;
      try {
        const before = this.snapshot(workspace);
        if (!before || this.applied.get(workspace.id) === before.key) continue;
        const observed = await this.client.show(workspace.repository, before.identity);
        if (this.closed) return;
        if (!sameWorkspace(workspace, observed))
          throw new Error('Orca workspace instance, repository or branch changed');
        const current = this.snapshot(this.store.workspace(workspace.id));
        if (!current || current.key !== before.key) continue;
        await this.client.setCard(workspace.repository, before.identity, before.card);
        this.applied.set(workspace.id, before.key);
        this.statuses.set(workspace.taskId, { problem: null });
      } catch {
        this.applied.delete(workspace.id);
        // Never expose CLI output here: a browser operation can carry the per-launch dashboard token.
        this.statuses.set(workspace.taskId, {
          problem: 'Orca card update unavailable. Task progress remains in Grampus.',
        });
      }
    }
  }

  /** Opens a task page inside its exact Orca workspace. The caller supplies this dashboard's access link. */
  async open(id: string, url: string): Promise<void> {
    const task = this.store.get(id);
    if (!task.guided?.workspaceId || task.deletedAt) throw new Error('This task has no ready Orca workspace');
    const workspace = this.store.workspace(task.guided.workspaceId);
    const before = this.snapshot(workspace);
    if (!before) throw new Error('This task has no ready Orca workspace');
    const observed = await this.client.show(workspace.repository, before.identity);
    if (!sameWorkspace(workspace, observed)) throw new Error('Orca workspace instance, repository or branch changed');
    const current = this.snapshot(this.store.workspace(workspace.id));
    if (!current || current.key !== before.key) throw new Error('Task changed; refresh before opening its workspace');
    await this.client.openDashboard(workspace.repository, url, before.identity);
  }

  /** Stops observations and waits for the last CLI operation before the journal closes. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
