// Owns the versioned read API the Vue client consumes: `GET /api/v1/overview`, `/api/v1/tasks/:id`,
// `/api/v1/tasks/:id/timeline`, `/api/v1/tasks/:id/changes` and `/api/v1/kickoffs/:id`. The server's
// usual guards (loopback, origin, bearer token) run before these routes. Journal facts are cached by
// journal revision; the DTOs are rebuilt from them on each request because workers and stalls change
// without a journal write. Responses never carry file inventories, snapshots or raw check output.
// Actions reuse the existing POST routes (see `view-model/actions.ts`).
import { z } from 'zod';
import { viewModelLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { versionInformation } from '../config/runtime.js';
import { availableQualityPasses } from '../domain/quality-passes.js';
import type { Task } from '../domain/workflow.js';
import { healthView } from '../health/health.js';
import type { StallWatchdog } from '../health/stalls.js';
import { RecordNotFoundError } from '../persistence/errors.js';
import type { Store } from '../persistence/store.js';
import type { Kickoffs } from '../orchestration/kickoff.js';
import { guidedSnapshot } from '../orchestration/guided/snapshots.js';
import { describeIssues } from '../process/boundary.js';
import type { ChangeV1, KickoffDetailV1, OverviewV1, TaskDetailV1, TimelinePageV1 } from './api-types.js';
import { HttpError } from './errors.js';
import type { JobView, ViewContext } from './view-model/context.js';
import { kickoffDetail, type KickoffView } from './view-model/kickoff-detail.js';
import { overview } from './view-model/overview.js';
import { taskDetail, taskFacts, type TaskFacts } from './view-model/task-detail.js';
import { timelinePage } from './view-model/timeline.js';

/** What the v1 routes read from the running dashboard. */
export interface ApiV1Dashboard {
  store: Store;
  kickoffs: Kickoffs;
  jobs: ReadonlyMap<string, JobView>;
  stalls: Pick<StallWatchdog, 'stall'>;
  now: () => number;
}

const route =
  /^\/api\/v1\/(?:(?<overview>overview)|(?<kind>tasks|kickoffs)\/(?<id>[a-f0-9-]+)(?:\/(?<sub>timeline|changes))?)$/;
const routeSchema = z.object({
  overview: z.literal('overview').optional(),
  kind: z.enum(['tasks', 'kickoffs']).optional(),
  id: z.string().optional(),
  sub: z.enum(['timeline', 'changes']).optional(),
});

const timelineQuery = z.object({
  cursor: z.coerce.number({ error: 'cursor must be a journal sequence' }).int().min(0).optional(),
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int()
    .min(1)
    .max(viewModelLimits.timelineMaxPageEntries)
    .default(viewModelLimits.timelinePageEntries),
});
const changesQuery = z.object({ path: z.string({ error: 'Name the changed path' }).min(1) });

/** The query parsed with `schema`; an empty parameter (`?cursor=`) counts as absent. */
function query<S extends z.ZodType>(schema: S, url: URL): z.output<S> {
  const result = schema.safeParse(Object.fromEntries([...url.searchParams].filter(([, value]) => value !== '')));
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  throw new HttpError(400, `Invalid request: ${issues.join('; ')}`, issues);
}

/** A record the controller refuses to show (deleted, not guided, not a kickoff) is not found here. */
function found<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RecordNotFoundError || error instanceof HttpError) throw error;
    throw new HttpError(404, error instanceof Error ? error.message : String(error));
  }
}

/** Values computed from the journal, kept while its revision is unchanged; the oldest is dropped first. */
class RevisionCache<T> {
  private readonly entries = new Map<string, { revision: string; value: T }>();

  get(key: string, revision: string, compute: () => T): T {
    const hit = this.entries.get(key);
    if (hit?.revision === revision) return hit.value;
    const value = compute();
    this.entries.delete(key);
    if (this.entries.size >= viewModelLimits.cachedViews) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { revision, value });
    return value;
  }
}

/** The v1 read routes of one dashboard, with their revision caches. */
export function createApiV1(dashboard: ApiV1Dashboard) {
  const { store, kickoffs } = dashboard;
  const overviews = new RevisionCache<{ tasks: TaskFacts[]; kickoffs: KickoffView[] }>(),
    tasks = new RevisionCache<TaskFacts>(),
    plans = new RevisionCache<KickoffView>();
  const context: ViewContext = {
    job: id => dashboard.jobs.get(id) ?? null,
    stall: id => dashboard.stalls.stall(id),
    qualityPasses: availableQualityPasses(currentSettings().qualityPasses),
  };
  const liveTask = (id: string): TaskFacts => {
    const task = store.get<Task>(id);
    if (task.deletedAt) throw new HttpError(404, 'This task was deleted');
    if (!task.guided) throw new HttpError(404, 'This task has no guided plan');
    return found(() => taskFacts(store, id));
  };

  function overviewRoute(revision: string): OverviewV1 {
    const inputs = overviews.get('overview', revision, () => ({
      tasks: store.guidedSummaries().map(summary => taskFacts(store, summary.id)),
      kickoffs: kickoffs.list().filter(item => !item.taskId),
    }));
    return overview(
      {
        ...inputs,
        health: healthView(store, dashboard.now()),
        application: versionInformation(currentSettings().dashboardPort),
        journal: store.path,
        poolLimit: currentSettings().maxConcurrentTasks,
        qualityPasses: context.qualityPasses,
      },
      context,
      revision,
    );
  }

  function taskRoute(id: string, revision: string, sub: 'timeline' | 'changes' | undefined, url: URL) {
    const facts = tasks.get(id, revision, () => liveTask(id));
    if (sub === 'timeline') {
      const { cursor, limit } = query(timelineQuery, url);
      return timelinePage(id, facts.events, cursor ?? null, limit) satisfies TimelinePageV1;
    }
    if (sub === 'changes') {
      const { path } = query(changesQuery, url);
      const change = guidedSnapshot(store, facts.view.state)?.diff.find(item => item.path === path);
      if (!change) throw new HttpError(404, 'No retained change for this path');
      return {
        apiVersion: 1,
        path,
        before: { content: change.previousContent, encoding: change.previousEncoding },
        after: { content: change.content, encoding: change.encoding },
      } satisfies ChangeV1;
    }
    return taskDetail(facts, context, revision) satisfies TaskDetailV1;
  }

  return {
    /** Answers a `GET /api/v1/...` path; unknown paths are 404. */
    get(path: string, url: URL): unknown {
      const groups = route.exec(path)?.groups;
      if (!groups) throw new HttpError(404, 'Not found');
      const matched = routeSchema.parse(groups);
      const revision = store.revision();
      if (matched.overview) return overviewRoute(revision);
      if (!matched.id) throw new HttpError(404, 'Not found');
      if (matched.kind === 'tasks') return taskRoute(matched.id, revision, matched.sub, url);
      if (matched.sub) throw new HttpError(404, 'Not found');
      const id = matched.id;
      const view = plans.get(id, revision, () => found(() => kickoffs.view(id)));
      return kickoffDetail(view, context, revision) satisfies KickoffDetailV1;
    },
  };
}
