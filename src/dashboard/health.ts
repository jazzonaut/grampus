// System health for the dashboard: every unfinished task's and comparison's driver, the workers still
// running, Orca itself, the agent providers' usage limits, and recent Orca hiccups, with the problems among
// them. Drivers and workers come from the same logs and lock files the rest of the dashboard reads; Orca
// and its providers are checked at most every `healthProbeMs`, since each check runs the Orca CLI.
import type { ComparisonState, StoredComparisonEvent } from '../compare/comparison.js';
import { ComparisonStore, listComparisonIds } from '../compare/comparison.js';
import { currentSettings } from '../config/settings.js';
import type { StoredEvent } from '../domain/events.js';
import { standardRecipe, type Recipe } from '../domain/recipe.js';
import { installationOf, installedBuild, packageRoot, selectedBuild } from '../install/installation.js';
import type { OrcaHealth } from '../orca/client.js';
import type { ProviderLimits } from '../orca/protocol.js';
import { lastActivity } from '../pipeline/driver-core.js';
import { currentDispatch, isOpen, type TaskState } from '../pipeline/state.js';
import { summarise } from '../pipeline/status.js';
import { driverHeartbeat } from '../store/driver-lock.js';
import { loadComparison } from './comparisons.js';
import type { TaskReader } from './tasks.js';
import type {
  DriverHealth,
  HealthProblem,
  HealthView,
  HiccupView,
  OrcaHealthView,
  ProviderHealth,
  UsageWindowView,
  WorkerHealth,
} from './types.js';

type Heartbeat = ReturnType<typeof driverHeartbeat>;

/** What one check of Orca found. */
export interface ProbeResult {
  orca: OrcaHealthView;
  providers: ProviderLimits[] | null;
  providersError: string | null;
}

/** Checks Orca and its providers, sharing one check between the requests of `healthProbeMs`. */
export class OrcaProbe {
  private last: { at: number; result: Promise<ProbeResult> } | null = null;

  constructor(private readonly orca: OrcaHealth) {}

  get(now = Date.now()): Promise<ProbeResult> {
    if (!this.last || now - this.last.at >= currentSettings().healthProbeMs)
      this.last = { at: now, result: this.run() };
    return this.last.result;
  }

  private async run(): Promise<ProbeResult> {
    const timeoutMs = currentSettings().healthProbeTimeoutMs;
    const started = Date.now();
    const [status, limits] = await Promise.allSettled([
      this.orca.status(timeoutMs).then(result => ({ result, latencyMs: Date.now() - started })),
      this.orca.providerLimits(timeoutMs),
    ]);
    const checkedAt = new Date().toISOString();
    const orca: OrcaHealthView =
      status.status === 'fulfilled'
        ? {
            ok: status.value.result.reachable !== false,
            version: status.value.result.version,
            state: status.value.result.state,
            appRunning: status.value.result.appRunning,
            latencyMs: status.value.latencyMs,
            error:
              status.value.result.reachable === false
                ? `Orca's runtime is not reachable (${status.value.result.state ?? 'state unknown'}).`
                : null,
            checkedAt,
          }
        : {
            ok: false,
            version: null,
            state: null,
            appRunning: null,
            latencyMs: null,
            error: (status.reason as Error).message,
            checkedAt,
          };
    return limits.status === 'fulfilled'
      ? { orca, providers: limits.value, providersError: null }
      : { orca, providers: null, providersError: (limits.reason as Error).message };
  }
}

/** Everything `buildHealth` judges, read from the data folder and Orca. */
export interface HealthInput {
  now: number;
  tasks: { state: TaskState; events: readonly StoredEvent[]; heartbeat: Heartbeat }[];
  comparisons: { state: ComparisonState; events: readonly StoredComparisonEvent[]; heartbeat: Heartbeat }[];
  unreadable: { taskId: string; error: string }[];
  probe: ProbeResult;
  grampus: HealthView['grampus'];
  /** Saved recipes, whose agents count as used even with no task running. */
  recipes: readonly Recipe[];
}

/** Read the system's health now. */
export async function readHealth(dataDir: string, reader: TaskReader, probe: OrcaProbe): Promise<HealthView> {
  const now = Date.now();
  const { tasks, unreadable } = reader.loadAll();
  const comparisons = listComparisonIds(dataDir).flatMap(id => {
    try {
      const dir = ComparisonStore.open(dataDir, id).dir;
      return [{ ...loadComparison(dataDir, id), heartbeat: driverHeartbeat(dir, now) }];
    } catch {
      return [];
    }
  });
  const build = installedBuild()?.build ?? null;
  return buildHealth({
    now,
    tasks: tasks.map(task => ({ ...task, heartbeat: driverHeartbeat(task.store.dir, now) })),
    comparisons,
    unreadable,
    probe: await probe.get(now),
    grampus: { dashboard: build, installed: build ? selectedBuild(installationOf(packageRoot)) : null },
    recipes: [standardRecipe, ...currentSettings().recipes],
  });
}

/** Judge the system from what was read. Pure, so it can be tested without Orca or lock files. */
export function buildHealth(input: HealthInput): HealthView {
  const { now, probe, grampus } = input;
  const settings = currentSettings();
  const open = input.tasks.filter(task => !task.state.finished);
  const drivers = [
    ...input.comparisons
      .filter(comparison => !comparison.state.finished)
      .map(({ state, events, heartbeat }) =>
        driverOf(
          {
            kind: 'comparison',
            id: state.comparisonId,
            title: state.title,
            link: `/comparisons/${state.comparisonId}`,
            phase: `${state.entries.length} of ${state.recipes.length} entries started`,
            lastStop: state.lastStop,
            createdAt: state.createdAt,
          },
          events,
          heartbeat,
          grampus.installed,
        ),
      ),
    ...open.map(({ state, events, heartbeat }) =>
      driverOf(
        {
          kind: 'task',
          id: state.taskId,
          title: taskName(state),
          link: `/tasks/${state.taskId}`,
          phase: summarise(state).phase,
          lastStop: state.lastStop,
          createdAt: state.createdAt,
        },
        events,
        heartbeat,
        grampus.installed,
      ),
    ),
  ];
  const workers = open.flatMap(({ state, events }) => workersOf(state, events, now, settings.stalledWorkerMs));
  const used = new Set([
    ...[...input.recipes, ...open.map(task => task.state.recipe)].flatMap(recipeAgents),
    ...workers.flatMap(worker => (worker.agent ? [worker.agent] : [])),
  ]);
  const providers = probe.providers
    ?.map(limits => providerOf(limits, used.has(limits.provider), settings.providerUsageWarnPercent))
    .filter(provider => provider.used || provider.status === 'ok');
  const problems = [
    ...orcaProblems(probe),
    ...driverProblems(drivers, grampus),
    ...workerProblems(workers),
    ...(providers ?? []).flatMap(providerProblems),
    ...input.unreadable.map((task): HealthProblem => ({
      id: `unreadable:${task.taskId}`,
      level: 'warning',
      title: `The log of ${task.taskId} cannot be read`,
      detail: task.error,
      link: null,
    })),
  ].sort((a, b) => Number(b.level === 'error') - Number(a.level === 'error'));
  return {
    asOf: new Date(now).toISOString(),
    level: problems.some(problem => problem.level === 'error') ? 'error' : problems.length ? 'warning' : 'ok',
    problems,
    orca: probe.orca,
    providers: providers ?? null,
    providersError: probe.providersError,
    grampus,
    drivers,
    workers,
    hiccups: hiccupsOf(input, now - settings.healthHistoryMs),
    historyMs: settings.healthHistoryMs,
    refreshMs: settings.healthProbeMs,
  };
}

interface DriverSubject {
  kind: DriverHealth['kind'];
  id: string;
  title: string;
  link: string;
  phase: string;
  lastStop: { reason: string; at: string } | null;
  createdAt: string;
}

function driverOf(
  subject: DriverSubject,
  events: readonly (StoredEvent | StoredComparisonEvent)[],
  heartbeat: Heartbeat,
  installed: string | null,
): DriverHealth {
  const startedAt = events.findLastIndex(event => event.type === 'driver.started');
  const started = events[startedAt];
  const build = started?.type === 'driver.started' ? (started.build ?? null) : null;
  const state = heartbeat?.alive ? 'alive' : subject.lastStop ? 'stopped' : 'starting';
  return {
    kind: subject.kind,
    id: subject.id,
    title: subject.title,
    link: subject.link,
    state,
    pid: heartbeat?.pid ?? null,
    heartbeatAt: heartbeat?.touchedAt ?? null,
    build,
    outdated: state === 'alive' && build !== null && installed !== null && build !== installed,
    phase: subject.phase,
    lastEventAt: events.at(-1)?.at ?? subject.createdAt,
    stop: state === 'stopped' ? subject.lastStop : null,
    busySince: state === 'alive' ? busySince(events.slice(Math.max(startedAt, 0))) : null,
  };
}

/** When the busy spell still going on began: an `orca.busy` with no `orca.room` after it. */
function busySince(events: readonly (StoredEvent | StoredComparisonEvent)[]): string | null {
  const busy = events.findLastIndex(event => event.type === 'orca.busy');
  const room = events.findLastIndex(event => event.type === 'orca.room');
  return busy > room ? (events[busy]?.at ?? null) : null;
}

function workersOf(state: TaskState, events: readonly StoredEvent[], now: number, quietMs: number): WorkerHealth[] {
  return [...state.stages.values()].flatMap(record => {
    const dispatch = currentDispatch(record);
    if (!dispatch || dispatch.settled || dispatch.stopped) return [];
    const last = lastActivity(state, events, record, dispatch);
    const asking = [...state.questions.values()].some(question => question.key === record.key && isOpen(question));
    const launch = dispatch.launch?.effective ?? dispatch.launch?.requested ?? null;
    const field = (name: string): string | null => {
      const value = launch?.[name];
      return typeof value === 'string' ? value : null;
    };
    return [
      {
        taskId: state.taskId,
        title: taskName(state),
        stageKey: record.key,
        dispatchId: dispatch.dispatchId,
        agent: field('agent'),
        model: field('model'),
        effort: field('effort'),
        startedAt: dispatch.startedAt,
        lastActivityAt: new Date(last).toISOString(),
        state: dispatch.exited ? 'exited' : asking ? 'asking' : now - last >= quietMs ? 'quiet' : 'working',
      },
    ];
  });
}

/** The agents a recipe assigns. */
function recipeAgents(recipe: Recipe): string[] {
  return [recipe.spec, recipe.specReview, recipe.testsFirst, recipe.build, recipe.review, recipe.polish]
    .concat(recipe.repair.assignment ?? null)
    .flatMap(assignment => (assignment ? [assignment.agent] : []));
}

const windowNames = { session: 'session', weekly: 'weekly', fableWeekly: 'weekly Fable', monthly: 'monthly' } as const;

function providerOf(limits: ProviderLimits, used: boolean, warnPercent: number): ProviderHealth {
  const windows = (Object.keys(windowNames) as (keyof typeof windowNames)[]).flatMap((key): UsageWindowView[] => {
    const window = limits[key];
    return window
      ? [
          {
            name: windowNames[key],
            usedPercent: window.usedPercent,
            level: window.usedPercent >= 100 ? 'error' : window.usedPercent >= warnPercent ? 'warning' : 'ok',
            resetsAt: typeof window.resetsAt === 'number' ? new Date(window.resetsAt).toISOString() : null,
            resetDescription: window.resetDescription ?? null,
          },
        ]
      : [];
  });
  const extra = limits.extraUsage;
  return {
    provider: limits.provider,
    status: limits.status,
    error: limits.error ?? null,
    used,
    windows,
    extraUsage:
      extra?.enabled && typeof extra.spent === 'number'
        ? { spent: extra.spent, limit: extra.spendLimit ?? null, currency: extra.currencyCode ?? null }
        : null,
  };
}

function orcaProblems(probe: ProbeResult): HealthProblem[] {
  const problems: HealthProblem[] = [];
  if (!probe.orca.ok)
    problems.push({
      id: 'orca',
      level: 'error',
      title: 'Orca is not answering',
      detail: probe.orca.error,
      link: '/system',
    });
  if (probe.providersError)
    problems.push({
      id: 'orca-accounts',
      level: 'warning',
      title: 'Orca could not report agent usage',
      detail: probe.providersError,
      link: '/system',
    });
  return problems;
}

function driverProblems(drivers: DriverHealth[], grampus: HealthView['grampus']): HealthProblem[] {
  const problems = drivers.flatMap((driver): HealthProblem[] =>
    driver.stop
      ? [
          {
            id: `driver:${driver.id}:${driver.stop.at}`,
            level: 'error',
            title: `Driver stopped: ${driver.title}`,
            detail: firstLine(driver.stop.reason),
            link: driver.link,
          },
        ]
      : [],
  );
  const busy = drivers.flatMap(driver => (driver.busySince ? [driver.busySince] : [])).sort();
  if (busy[0])
    problems.push({
      id: `orca-busy:${busy[0]}`,
      level: 'warning',
      title: `Orca is busy: ${plural(busy.length, 'driver')} waiting for room`,
      detail: 'All of its long-poll slots are taken. Drivers wait and carry on; nothing is lost.',
      link: '/system',
    });
  const outdated = drivers.filter(driver => driver.outdated);
  if (outdated.length && grampus.installed)
    problems.push({
      id: `outdated:${grampus.installed}`,
      level: 'warning',
      title: `${plural(outdated.length, 'driver')} on an older build`,
      detail: `They keep the build they started with until they restart; ${grampus.installed} is installed.`,
      link: '/system',
    });
  if (grampus.dashboard && grampus.installed && grampus.dashboard !== grampus.installed)
    problems.push({
      id: `dashboard:${grampus.installed}`,
      level: 'warning',
      title: 'The dashboard runs an older build',
      detail: `It runs ${grampus.dashboard}; restart \`grampus dashboard\` to run ${grampus.installed}.`,
      link: '/system',
    });
  return problems;
}

function workerProblems(workers: WorkerHealth[]): HealthProblem[] {
  return workers.flatMap((worker): HealthProblem[] =>
    worker.state === 'quiet' || worker.state === 'exited'
      ? [
          {
            id: `${worker.state}:${worker.dispatchId}`,
            level: 'warning',
            title:
              worker.state === 'quiet'
                ? `${worker.stageKey} of ${worker.title} has gone quiet`
                : `${worker.stageKey} of ${worker.title} exited without reporting`,
            detail: `Last heard from at ${worker.lastActivityAt}.`,
            link: `/tasks/${worker.taskId}`,
          },
        ]
      : [],
  );
}

function providerProblems(provider: ProviderHealth): HealthProblem[] {
  if (!provider.used) return [];
  if (provider.status !== 'ok')
    return [
      {
        id: `provider:${provider.provider}`,
        level: 'error',
        title: `${provider.provider} is unavailable to Orca`,
        detail: provider.error,
        link: '/system',
      },
    ];
  return provider.windows.flatMap((window): HealthProblem[] => {
    if (window.level === 'ok') return [];
    const full = window.level === 'error';
    const resets = window.resetDescription ? `Resets ${window.resetDescription}.` : null;
    return [
      {
        id: `limit:${provider.provider}:${window.name}:${full ? 'full' : 'near'}:${window.resetsAt ?? ''}`,
        level: window.level,
        title: full
          ? `${provider.provider} has reached its ${window.name} limit`
          : `${provider.provider} has used ${window.usedPercent}% of its ${window.name} limit`,
        detail: resets,
        link: '/system',
      },
    ];
  });
}

function hiccupsOf(input: HealthInput, from: number): HiccupView[] {
  const recent = (at: string) => Date.parse(at) >= from;
  const task = input.tasks.flatMap(({ state, events }) => {
    const source = { kind: 'task' as const, id: state.taskId, title: taskName(state), link: `/tasks/${state.taskId}` };
    return events.flatMap((event): HiccupView[] => {
      if (!recent(event.at)) return [];
      if (event.type === 'orca.busy') return [{ at: event.at, kind: 'busy', source, detail: event.detail }];
      if (event.type === 'orca.room')
        return [{ at: event.at, kind: 'room', source, detail: `Waited ${Math.round(event.waitedMs / 1000)} s` }];
      if (event.type === 'orca.uncertain')
        return [{ at: event.at, kind: 'uncertain', source, detail: `${event.detail} (repeat ${event.repeat})` }];
      if (event.type === 'driver.stopped') return [{ at: event.at, kind: 'stopped', source, detail: event.reason }];
      return [];
    });
  });
  const comparison = input.comparisons.flatMap(({ state, events }) => {
    const source = {
      kind: 'comparison' as const,
      id: state.comparisonId,
      title: state.title,
      link: `/comparisons/${state.comparisonId}`,
    };
    return events.flatMap((event): HiccupView[] =>
      event.type === 'driver.stopped' && recent(event.at)
        ? [{ at: event.at, kind: 'stopped', source, detail: event.reason }]
        : [],
    );
  });
  return [...task, ...comparison].sort((a, b) => b.at.localeCompare(a.at));
}

/** A task's name on this page: a comparison entry leads with its recipe, since entries share a title. */
function taskName(state: TaskState): string {
  return state.comparisonId ? `${state.recipe.name}: ${state.title}` : state.title;
}

/** The first line of a stop reason, which is often an error with its stack trace. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
