// Owns the versioned read API the Vue client consumes: `GET /api/v1/overview`, `/api/v1/tasks/:id`,
// `/api/v1/tasks/:id/timeline`, `/api/v1/tasks/:id/changes`, `/api/v1/kickoffs/:id`, `/api/v1/settings` and
// `/api/v1/orca-worktrees`. The server's
// usual guards (interface host, origin, optional bearer token) run before these routes. Journal facts are cached by
// journal revision; the DTOs are rebuilt from them on each request because workers and stalls change
// without a journal write; the runner pool is read once per request. Responses never carry file inventories, snapshots or raw check output.
// Actions reuse the existing POST routes (see `view-model/actions.ts`).
import { z } from 'zod';
import { viewModelLimits } from '../config/limits.js';
import { currentSettings, readSettingsFile } from '../config/settings.js';
import { versionInformation } from '../config/runtime.js';
import { availableQualityPasses } from '../domain/quality-passes.js';
import { healthView, sanitiseDetail } from '../health/health.js';
import type { StallWatchdog } from '../health/stalls.js';
import { RecordNotFoundError } from '../persistence/errors.js';
import type { Store } from '../persistence/store.js';
import type { Kickoffs } from '../orchestration/kickoff.js';
import { guidedSnapshot } from '../orchestration/guided/snapshots.js';
import { Workspaces } from '../repository/workspaces.js';
import type { OrcaPresentation } from '../repository/orca-presentation.js';
import type { OrcaDesktopClient } from '../repository/orca.js';
import { readLiveChanges } from './live-changes.js';
import { runnerPool } from '../orchestration/guided/runner-pool.js';
import { describeIssues } from '../process/boundary.js';
import type {
  ChangeV1,
  KickoffDetailV1,
  OrcaWorktreesV1,
  OverviewV1,
  ObservabilityV1,
  ActivitySubjectV1,
  SettingsV1,
  TaskDetailV1,
  TimelinePageV1,
} from './api-types.js';
import { HttpError } from './errors.js';
import type { JobView, ViewContext } from './view-model/context.js';
import { kickoffDetail, type KickoffView } from './view-model/kickoff-detail.js';
import { overview, overviewTasks, type UnreadableTask } from './view-model/overview.js';
import { orcaWorktreeChoices, unavailableOrcaWorktrees } from './view-model/orca-worktrees.js';
import { settingsView } from './view-model/settings.js';
import { taskDetail, taskFacts, type TaskFacts } from './view-model/task-detail.js';
import { timelinePage } from './view-model/timeline.js';
import { observabilityView } from './view-model/observability.js';
import { ControllerObservations } from '../health/controller-observations.js';

/** What the v1 routes read from the running dashboard. */
export interface ApiV1Dashboard {
  store: Store;
  kickoffs: Kickoffs;
  jobs: ReadonlyMap<string, JobView>;
  stalls: Pick<StallWatchdog, 'stall'>;
  now: () => number;
  /** The data directory whose `config.json` the Settings screen edits, or null when there is none. */
  settingsDirectory: string | null;
  /** The optional desktop projector, separate from workflow and provider health. */
  orca?: OrcaPresentation | null;
  /** The Orca client New task lists repository folder choices from; none when Orca is not configured. */
  orcaClient?: Pick<OrcaDesktopClient, 'choices'> | null;
}

const route =
  /^\/api\/v1\/(?:(?<overview>overview)|(?<settings>settings)|(?<worktrees>orca-worktrees)|(?<kind>tasks|kickoffs)\/(?<id>[a-f0-9-]+)(?:\/(?<sub>timeline|changes|live-changes|observability))?)$/;
const routeSchema = z.object({
  overview: z.literal('overview').optional(),
  settings: z.literal('settings').optional(),
  worktrees: z.literal('orca-worktrees').optional(),
  kind: z.enum(['tasks', 'kickoffs']).optional(),
  id: z.string().optional(),
  sub: z.enum(['timeline', 'changes', 'live-changes', 'observability']).optional(),
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
const liveChangesQuery = z.object({ path: z.string().min(1).optional() });

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

function readObservability(store: Store, subject: ActivitySubjectV1, before: string | null): ObservabilityV1 {
  if (subject.kind === 'task') {
    const task = store.get(subject.id);
    if (task.deletedAt || !task.guided) throw new HttpError(404, 'This task is not available');
  } else {
    const session = store.session(subject.id);
    if (session.deletedAt || !store.sessionEvents(subject.id, ['kickoff.created']).length)
      throw new HttpError(404, 'This planning conversation is not available');
  }
  return observabilityView(store, subject, before);
}

/** Orca is optional: a missing client or a failed listing withdraws the choice rather than failing New task. */
async function worktreesRoute(dashboard: ApiV1Dashboard): Promise<OrcaWorktreesV1> {
  const client = dashboard.orcaClient;
  if (!client) return unavailableOrcaWorktrees;
  try {
    const { worktrees, omitted } = await client.choices(process.cwd(), viewModelLimits.orcaWorktreeChoices);
    return orcaWorktreeChoices(worktrees, omitted);
  } catch (error) {
    console.error(`Orca worktree choices: ${sanitiseDetail(error instanceof Error ? error.message : String(error))}`);
    return unavailableOrcaWorktrees;
  }
}

/** Refreshes observations outside journal transactions; unreadable task records remain the overview's concern. */
function refreshControllers(store: Store, controllers: ControllerObservations): void {
  const owners = store.runnerOwners().flatMap(id => {
    try {
      const owner = store.get(id).guided?.owner;
      return owner ? [owner] : [];
    } catch {
      return [];
    }
  });
  void controllers.refresh(owners).catch(() => {});
}

/** The v1 read routes of one dashboard, with their revision caches. */
export function createApiV1(dashboard: ApiV1Dashboard, controllers = new ControllerObservations()) {
  const { store, kickoffs } = dashboard;
  const overviews = new RevisionCache<{
      tasks: TaskFacts[];
      unreadable: UnreadableTask[];
      kickoffs: KickoffView[];
    }>(),
    tasks = new RevisionCache<TaskFacts>(),
    plans = new RevisionCache<KickoffView>(),
    activity = new RevisionCache<ObservabilityV1>();
  const qualityPasses = availableQualityPasses(currentSettings().qualityPasses);
  const requestContext = (): ViewContext => ({
    job: id => dashboard.jobs.get(id) ?? null,
    stall: id => dashboard.stalls.stall(id),
    controller: owner => controllers.state(owner),
    qualityPasses,
    pool: runnerPool(store),
    orca: dashboard.orca ? id => dashboard.orca?.status(id) ?? null : undefined,
  });
  const liveTask = (id: string): TaskFacts => {
    const task = store.get(id);
    if (task.deletedAt) throw new HttpError(404, 'This task was deleted');
    if (!task.guided) throw new HttpError(404, 'This task has no guided plan');
    return found(() => taskFacts(store, id));
  };

  function overviewRoute(context: ViewContext, revision: string): OverviewV1 {
    const inputs = overviews.get('overview', revision, () => {
      const { tasks, unreadable } = overviewTasks(store);
      // Logged once per journal revision, since the result is cached; the error text is bounded and redacted.
      for (const { id, category, error } of unreadable)
        console.error(
          `Overview: task ${id} could not be read (${category}): ${sanitiseDetail(error instanceof Error ? error.message : String(error))}`,
        );
      return {
        tasks,
        unreadable: unreadable.map(({ error: _error, ...task }) => task),
        kickoffs: kickoffs.list().filter(item => !item.taskId),
      };
    });
    return overview(
      {
        ...inputs,
        health: healthView(store, dashboard.now()),
        application: versionInformation(currentSettings().dashboardPort),
        journal: store.path,
        qualityPasses,
      },
      context,
      revision,
    );
  }

  async function taskRoute(
    context: ViewContext,
    id: string,
    revision: string,
    sub: 'timeline' | 'changes' | 'live-changes' | undefined,
    url: URL,
  ) {
    const facts = tasks.get(id, revision, () => liveTask(id));
    if (sub === 'live-changes') {
      const { path } = query(liveChangesQuery, url);
      const workspaceId = facts.view.state.workspaceId;
      if (!workspaceId || facts.view.workspace?.phase !== 'ready')
        throw new HttpError(404, 'The task workspace is not ready for live observations');
      const { workspace } = await new Workspaces(store).inspect(workspaceId, false);
      if (!workspace.path) throw new HttpError(404, 'The task workspace path is unknown');
      return readLiveChanges(workspace.path, workspace.baseCommit, path);
    }
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
      if (matched.settings) {
        const directory = dashboard.settingsDirectory;
        return settingsView({
          file: directory === null ? null : readSettingsFile(directory),
          active: currentSettings(),
        }) satisfies SettingsV1;
      }
      if (matched.worktrees) return worktreesRoute(dashboard);
      // OS observations must refresh even when the journal revision is unchanged. Identity helpers
      // run asynchronously and are coalesced, so polling does not block HTTP or repeatedly spawn them.
      refreshControllers(store, controllers);
      const revision = store.revision();
      const context = requestContext();
      if (matched.overview) return overviewRoute(context, revision);
      if (!matched.id) throw new HttpError(404, 'Not found');
      if (matched.sub === 'observability') {
        const subject: ActivitySubjectV1 = {
          kind: matched.kind === 'tasks' ? 'task' : 'planning',
          id: matched.id,
        };
        const before = url.searchParams.get('before');
        return activity.get(`${subject.kind}:${subject.id}:${before ?? ''}`, revision, () =>
          readObservability(store, subject, before),
        );
      }
      if (matched.kind === 'tasks') return taskRoute(context, matched.id, revision, matched.sub, url);
      if (matched.sub) throw new HttpError(404, 'Not found');
      const id = matched.id;
      const view = plans.get(id, revision, () => found(() => kickoffs.view(id)));
      return kickoffDetail(view, context, revision) satisfies KickoffDetailV1;
    },
  };
}
