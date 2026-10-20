// Owns sequential comparison orchestration. Members are ordinary guided tasks with independent
// evidence; a durable driver owner prevents a restart or second caller from dispatching another run.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { Task } from '../domain/workflow.js';
import { deepEqual } from '../domain/deep-equal.js';
import {
  comparisonDigest,
  comparisonDecisionKey,
  sharedPlanDigest,
  requireComparisonMember,
  comparisonCurrentRun,
  type Comparison,
} from '../domain/comparison.js';
import { resolveModelProfile } from '../domain/model-profiles.js';
import { guidedPlanDigest } from '../domain/guided-plan.js';
import { profileLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { currentProcessStartedAt } from '../process/process-identity.js';
import { processAlive } from '../verification/check-recovery.js';
import { StaleStateError } from '../persistence/errors.js';
import { GuidedTasks } from './guided/controller.js';
import type { GuidedServices, GuidedState } from './guided/state.js';
import { comparisonRetries, type ComparisonRetry } from '../domain/comparison-retries.js';
import { guidedDecisionKey, guidedQuestionKey } from './guided/keys.js';
import { comparisonRetryProblem } from './comparison-retry-policy.js';
import { assertRunnerAvailable } from './guided/runner-pool.js';

/** Comparison state changes journalled with their state in the same transaction. */
export function changeComparison(
  store: Store,
  id: string,
  type: string,
  update: (value: Comparison) => void,
  details: Record<string, unknown> = {},
): Comparison {
  return store.transaction(() => {
    const value = store.comparison(id);
    update(value);
    value.revision++;
    store.saveComparison(value);
    store.appendComparison(id, type, { ...value, ...details });
    return value;
  });
}

/** Refuses a stale user decision on a comparison or its exact approved membership. */
export function requireComparisonDecision(value: Comparison, expected: string): void {
  if (
    comparisonDecisionKey(value) !== expected ||
    comparisonDigest(value) !== value.digest ||
    sharedPlanDigest(value.plan) !== value.sharedDigest
  )
    throw new StaleStateError('Comparison changed; inspect its current plan and profiles');
}

/** Sequential runs over the same work contract; no planning or provider turn is replayed. */
export class Comparisons {
  constructor(
    private readonly store: Store,
    private readonly services: GuidedServices = {},
  ) {}

  /** Creates all unapproved member tasks atomically from the displayed source plan and profile snapshots. */
  create(sourceTaskId: string, expectedDigest: string, profiles: unknown[]): Comparison {
    const source = this.store.get(sourceTaskId).guided;
    if (!source || source.digest !== expectedDigest || guidedPlanDigest(source.plan) !== expectedDigest)
      throw new StaleStateError('Source plan changed; inspect it before creating a comparison');
    if (source.plan.revision)
      throw new Error('Compare an original plan from its pinned base, rather than a retained revision');
    if (profiles.length < profileLimits.comparisonMinimumRuns || profiles.length > profileLimits.comparisonRuns)
      throw new Error(`Choose ${profileLimits.comparisonMinimumRuns} to ${profileLimits.comparisonRuns} profiles`);
    const selected = profiles.map(value => resolveModelProfile(value, currentSettings().modelProfiles));
    if (new Set(selected.map(profile => profile.id)).size !== selected.length)
      throw new Error('Choose distinct profiles');
    const id = randomUUID();
    const tasks = new GuidedTasks(this.store, this.services);
    const plan = structuredClone(source.plan);
    const linked = z
      .object({ sessionId: z.string() })
      .safeParse(this.store.events(sourceTaskId, ['guided.kickoff_linked']).at(-1)?.data);
    return this.store.transaction(() => {
      const runs = selected.map((profile, index) => {
        const task = tasks.create({
          ...plan,
          modelProfile: profile,
          workspace: {
            ...plan.workspace,
            path: undefined,
            ...(plan.workspace.adapter === 'git'
              ? {
                  path: join(
                    dirname(plan.workspace.path ?? plan.workspace.repo),
                    `grampus-comparison-${id}-${index + 1}`,
                  ),
                }
              : {}),
          },
        });
        if (!task.guided) throw new Error('Comparison member has no guided plan');
        this.store.append(task.id, task.version, 'comparison.linked', { comparisonId: id, index });
        return { taskId: task.id, version: task.version, digest: task.guided.digest, profile };
      });
      const value: Comparison = {
        revision: 0,
        id,
        name: plan.brief.title,
        createdAt: new Date().toISOString(),
        sourceTaskId,
        plan,
        sharedDigest: sharedPlanDigest(plan),
        digest: '',
        approvedDigest: null,
        planningSessionId: linked.data?.sessionId ?? null,
        runs,
        cursor: 0,
        pauseRequested: false,
        status: 'draft',
        owner: null,
        preferredTaskId: null,
        note: 'Inspect the shared plan and every profile before approving.',
        integration: null,
      };
      value.digest = comparisonDigest(value);
      this.store.saveComparison(value);
      this.store.appendComparison(id, 'comparison.created', value);
      return value;
    });
  }

  /** Batch approval validates every exact member plan; one mismatch rolls back all approvals. */
  approve(id: string, expected: string): Comparison {
    return changeComparison(this.store, id, 'comparison.approved', value => {
      requireComparisonDecision(value, expected);
      if (value.status !== 'draft' || value.owner) throw new Error('Comparison is not awaiting approval');
      for (const run of value.runs) {
        const task = this.store.get(run.taskId);
        const state = task.guided;
        if (
          !state ||
          task.version !== run.version ||
          state.version !== run.version ||
          state.digest !== run.digest ||
          !deepEqual(task.brief, state.plan.brief) ||
          sharedPlanDigest(state.plan) !== value.sharedDigest ||
          guidedPlanDigest(state.plan) !== run.digest
        )
          throw new StaleStateError('A comparison member no longer matches the shared plan');
        if (approvedUnstartedMember(this.store, task, run)) continue;
        new GuidedTasks(this.store).approve(run.taskId, run.version, run.digest);
      }
      value.approvedDigest = value.digest;
      value.status = 'ready';
      value.note = 'Approved. Run profiles one after another.';
    });
  }

  /** Runs only the current ready member; waits at human or recovery boundaries and retains failures. */
  async run(id: string, expected: string, signal?: AbortSignal): Promise<Comparison> {
    const owner = {
      token: randomUUID(),
      controllerPid: process.pid,
      controllerStartedAt: currentProcessStartedAt(),
      host: hostname(),
    };
    changeComparison(this.store, id, 'comparison.started', value => {
      requireComparisonDecision(value, expected);
      if (value.owner || value.approvedDigest !== value.digest || ['draft', 'complete'].includes(value.status))
        throw new Error('Comparison is unapproved, complete or already owned; inspect recovery if its owner exited');
      value.owner = owner;
      value.pauseRequested = false;
      value.status = 'running';
      value.note = 'Running profiles sequentially.';
    });
    try {
      await this.drive(id, owner.token, signal);
    } finally {
      changeComparison(this.store, id, 'comparison.driver_settled', value => {
        if (value.owner?.token !== owner.token) throw new Error('Comparison owner changed');
        value.owner = null;
        if (value.status === 'running') {
          value.status = 'waiting';
          value.note = 'Driver settled. Inspect the current run before continuing.';
        }
      });
    }
    const settled = this.store.comparison(id);
    const retries = comparisonRetries(this.store, id);
    if (
      !signal?.aborted &&
      !settled.owner &&
      !settled.pauseRequested &&
      !retries.active &&
      retries.pending.length &&
      retryDispatchReady(this.store, settled, nextRetry(settled, retries.pending))
    )
      await this.driveQueuedRetry(id, signal);
    return this.store.comparison(id);
  }

  /** Queues one exact repair decision behind active work, or immediately drives an idle comparison. */
  async retry(taskId: string, expected?: string, signal?: AbortSignal): Promise<GuidedState> {
    const group = this.store.transaction(() => this.queueRetry(taskId, expected));
    if (!group.owner && !group.pauseRequested) await this.driveQueuedRetry(group.id, signal);
    return new GuidedTasks(this.store).get(taskId);
  }

  private async driveQueuedRetry(id: string, signal?: AbortSignal): Promise<void> {
    const current = this.store.comparison(id);
    if (current.owner || current.pauseRequested || signal?.aborted) return;
    try {
      await this.run(id, comparisonDecisionKey(current), signal);
    } catch (error) {
      // Another queue decision or driver may win between the read and claim. The request is already
      // durable; reread ownership instead of reporting a failed action or duplicating its dispatch.
      if (!(error instanceof StaleStateError)) throw error;
      await this.driveQueuedRetry(id, signal);
    }
  }

  private queueRetry(taskId: string, expected?: string): Comparison {
    const group = this.store.comparisons().find(item => item.runs.some(run => run.taskId === taskId));
    if (!group) throw new Error('Task does not belong to a comparison');
    requireComparisonDecision(group, comparisonDecisionKey(group));
    const problem = comparisonRetryProblem(this.store, group, taskId);
    if (problem) throw new Error(problem);
    if (!group.owner && !group.pauseRequested) assertRunnerAvailable(this.store);
    const state = new GuidedTasks(this.store).get(taskId);
    const key = guidedDecisionKey(state, guidedQuestionKey(this.store, state));
    if (expected !== undefined && expected !== key)
      throw new StaleStateError('Task changed since you inspected it; refresh before taking this action');
    const retry: ComparisonRetry = { id: randomUUID(), taskId, expected: key };
    const queued = changeComparison(
      this.store,
      group.id,
      'comparison.retry_requested',
      value => {
        if (value.status === 'complete') value.status = 'ready';
        value.note = 'Repair retry queued. The active run finishes before this repair starts.';
      },
      { retry },
    );
    this.store.append(taskId, state.version, 'guided.comparison_retry_queued', {
      comparisonId: group.id,
      requestId: retry.id,
      status: state.status,
      stage: state.stage,
      note: 'Repair retry queued. The current comparison run finishes first; approved files and repair usage are kept.',
      reasonCode: state.stopReason?.code ?? null,
    });
    return queued;
  }

  private async drive(id: string, token: string, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const value = this.store.comparison(id);
      if (value.owner?.token !== token) throw new Error('Comparison owner changed');
      if (value.pauseRequested) return;
      const retries = comparisonRetries(this.store, id);
      const retry = nextRetry(value, retries.pending);
      if (!retries.active && retry && retryDispatchReady(this.store, value, retry)) {
        if (!(await this.startRetry(id, token, retry, signal))) return;
        continue;
      }
      const run = comparisonCurrentRun(this.store, value);
      if (!run) {
        const complete = this.store.transaction(() => {
          const latest = comparisonRetries(this.store, id);
          if (latest.active || latest.pending.length) return false;
          changeComparison(this.store, id, 'comparison.completed', current => {
            current.status = 'complete';
            current.note = 'Runs settled. Inspect results and select a preferred run.';
          });
          return true;
        });
        if (complete) return;
        continue;
      }
      requireComparisonMember(this.store, run.taskId);
      let state = new GuidedTasks(this.store).get(run.taskId);
      if (state.status === 'ready' || state.stopReason?.code === 'USER_PAUSED') {
        try {
          state = await new GuidedTasks(this.store, this.services).run(run.taskId, signal);
        } catch (error) {
          changeComparison(this.store, id, 'comparison.waiting', current => {
            current.status = 'waiting';
            current.note = error instanceof Error ? error.message : String(error);
          });
          return;
        }
      }
      if (this.store.comparison(id).pauseRequested) return;
      const finished = finishedMember(this.store, state);
      if (!finished) {
        changeComparison(this.store, id, 'comparison.waiting', current => {
          current.status = 'waiting';
          current.note = state.note;
        });
        return;
      }
      const advanced = this.store.transaction(() => {
        const current = this.store.comparison(id);
        if (current.owner?.token !== token) throw new Error('Comparison owner changed');
        if (current.pauseRequested || !finishedMember(this.store, new GuidedTasks(this.store).get(run.taskId)))
          return false;
        if (retries.active)
          changeComparison(this.store, id, 'comparison.retry_finished', () => {}, { retry: retries.active });
        else
          changeComparison(this.store, id, 'comparison.run_settled', value => {
            value.cursor++;
          });
        return true;
      });
      if (!advanced) return;
    }
  }

  private async startRetry(id: string, token: string, retry: ComparisonRetry, signal?: AbortSignal): Promise<boolean> {
    changeComparison(
      this.store,
      id,
      'comparison.retry_started',
      value => {
        if (value.owner?.token !== token) throw new Error('Comparison owner changed');
        value.note = 'Retrying a failed run with its retained files and approved allowances.';
      },
      { retry },
    );
    try {
      await new GuidedTasks(this.store, { ...this.services, expectedState: retry.expected }).retry(
        retry.taskId,
        signal,
      );
      return true;
    } catch (error) {
      const state = new GuidedTasks(this.store).get(retry.taskId);
      this.store.transaction(() => {
        if (finishedMember(this.store, state))
          changeComparison(this.store, id, 'comparison.retry_finished', () => {}, { retry });
        changeComparison(this.store, id, 'comparison.waiting', current => {
          current.status = 'waiting';
          current.note = error instanceof Error ? error.message : String(error);
        });
      });
      return false;
    }
  }

  /** Pauses after the active task operation settles without interrupting its tools. */
  pause(id: string, expected: string): Comparison {
    return changeComparison(this.store, id, 'comparison.pause_requested', value => {
      requireComparisonDecision(value, expected);
      if (!value.owner || value.pauseRequested) throw new Error('No running comparison to pause');
      value.pauseRequested = true;
      value.note = 'Pause requested. The active operation will settle before further comparison work.';
      const run = comparisonCurrentRun(this.store, value);
      if (run && this.store.get(run.taskId).guided?.owner) new GuidedTasks(this.store).pause(run.taskId);
    });
  }

  /** Releases only a provably dead driver. Member operations still require their normal explicit recovery. */
  recover(id: string, expected: string): Comparison {
    return changeComparison(this.store, id, 'comparison.recovered', value => {
      requireComparisonDecision(value, expected);
      if (
        !value.owner ||
        value.owner.host !== hostname() ||
        processAlive(value.owner.controllerPid, value.owner.controllerStartedAt)
      )
        throw new Error('Previous comparison driver is alive, unverifiable or belongs to another host');
      value.owner = null;
      value.status = 'waiting';
      value.note = 'Driver released. Inspect the current member and recover it if required; no operation was replayed.';
    });
  }

  /** Records preference separately from any write to the source repository. */
  select(id: string, expected: string, taskId: string): Comparison {
    return changeComparison(this.store, id, 'comparison.preferred', value => {
      requireComparisonDecision(value, expected);
      if (value.owner || value.status !== 'complete' || value.integration)
        throw new Error('Wait for the comparison to settle before selecting a result');
      const run = value.runs.find(item => item.taskId === taskId),
        task = this.store.get(taskId);
      if (
        !run ||
        task.version !== run.version ||
        task.guided?.status !== 'complete' ||
        task.guided.digest !== run.digest ||
        task.phase !== 'complete'
      )
        throw new Error('Select a verified completed run with its original approved configuration');
      value.preferredTaskId = taskId;
    });
  }
}

/** An earlier individual approval must not strand a batch, but retained work cannot bypass approval. */
function approvedUnstartedMember(store: Store, task: Task, run: Comparison['runs'][number]): boolean {
  const state = task.guided;
  return (
    !task.deletedAt &&
    task.phase === 'ready' &&
    task.approvedVersion === run.version &&
    task.attempt === null &&
    state?.status === 'ready' &&
    state.approvedDigest === run.digest &&
    state.stage === 'workspace' &&
    state.owner === null &&
    state.pending === null &&
    state.workspaceId === null &&
    !store.workspaces().some(workspace => workspace.taskId === task.id)
  );
}

/** A completed or failed member advances only after its controller and workspace lease settle. */
function finishedMember(store: Store, state: GuidedState): boolean {
  if (state.owner || state.pending) return false;
  if (state.workspaceId && store.lease(state.workspaceId)) return false;
  return state.status === 'complete' || (state.status === 'blocked' && state.stopReason?.code !== 'USER_PAUSED');
}

/** Human questions and unfinished operations still belong to the current run, ahead of queued work. */
function retryDispatchReady(store: Store, value: Comparison, retry: ComparisonRetry | undefined): boolean {
  const run = value.runs[value.cursor];
  if (!run) return true;
  const state = new GuidedTasks(store).get(run.taskId);
  return (
    finishedMember(store, state) ||
    (!state.owner &&
      !state.pending &&
      ((state.status === 'ready' && state.stage === 'workspace') ||
        (retry?.taskId === run.taskId && ['blocked', 'awaiting_scope', 'awaiting_assessment'].includes(state.status))))
  );
}

/** A retry of the current checkpoint resolves that run before earlier failures get their next turn. */
function nextRetry(value: Comparison, pending: ComparisonRetry[]): ComparisonRetry | undefined {
  return pending.find(retry => retry.taskId === value.runs[value.cursor]?.taskId) ?? pending[0];
}
