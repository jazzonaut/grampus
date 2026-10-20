// Owns sequential comparison orchestration. Members are ordinary guided tasks with independent
// evidence; a durable driver owner prevents a restart or second caller from dispatching another run.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import {
  comparisonDigest,
  comparisonDecisionKey,
  sharedPlanDigest,
  requireComparisonMember,
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

/** Comparison state changes journalled with their state in the same transaction. */
export function changeComparison(
  store: Store,
  id: string,
  type: string,
  update: (value: Comparison) => void,
): Comparison {
  return store.transaction(() => {
    const value = store.comparison(id);
    update(value);
    value.revision++;
    store.saveComparison(value);
    store.appendComparison(id, type, value);
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
        const state = this.store.get(run.taskId).guided;
        if (
          !state ||
          sharedPlanDigest(state.plan) !== value.sharedDigest ||
          guidedPlanDigest(state.plan) !== run.digest
        )
          throw new StaleStateError('A comparison member no longer matches the shared plan');
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
    return this.store.comparison(id);
  }

  private async drive(id: string, token: string, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const value = this.store.comparison(id),
        run = value.runs[value.cursor];
      if (value.owner?.token !== token) throw new Error('Comparison owner changed');
      if (value.pauseRequested) return;
      if (!run) return;
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
      changeComparison(this.store, id, 'comparison.run_settled', current => {
        current.cursor++;
        if (current.cursor === current.runs.length) {
          current.status = 'complete';
          current.note = 'Runs settled. Inspect results and select a preferred run.';
        }
      });
      if (this.store.comparison(id).status === 'complete') return;
    }
  }

  /** Pauses after the active task operation settles without interrupting its tools. */
  pause(id: string, expected: string): Comparison {
    return changeComparison(this.store, id, 'comparison.pause_requested', value => {
      requireComparisonDecision(value, expected);
      if (!value.owner || value.pauseRequested) throw new Error('No running comparison to pause');
      value.pauseRequested = true;
      value.note = 'Pause requested. The active operation will settle before further comparison work.';
      const run = value.runs[value.cursor];
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

/** A completed or failed member advances only after its controller and workspace lease settle. */
function finishedMember(store: Store, state: GuidedState): boolean {
  if (state.owner || state.pending) return false;
  if (state.workspaceId && store.lease(state.workspaceId)) return false;
  return state.status === 'complete' || (state.status === 'blocked' && state.stopReason?.code !== 'USER_PAUSED');
}
