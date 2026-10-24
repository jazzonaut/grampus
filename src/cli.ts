#!/usr/bin/env node
// The `grampus` command line. Every control action is a command queued for the task's driver, so the
// CLI, an Orca chat agent using the Grampus skill and the dashboard all control tasks the same way.
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { usageText } from './commands.js';
import { dataDirectory } from './config/paths.js';
import { availableRecipes, currentSettings, loadSettings, useSettings } from './config/settings.js';
import { listComparisonIds } from './compare/comparison.js';
import { startComparison } from './compare/create.js';
import { comparisonRecipes, comparisonPolicyPreview } from './compare/policy.js';
import { deliverySchema } from './domain/recipe.js';
import { driveComparison } from './compare/driver.js';
import { renderComparison, summariseComparison, type ComparisonSummary } from './compare/status.js';
import {
  approvedVersion,
  chatCommand,
  queueCommand,
  queueComparisonCommand,
  selfCommand,
  type CommandBody,
  type CommandSource,
} from './control.js';
import { serveDashboard } from './dashboard/server.js';
import { taskDetail } from './dashboard/views.js';
import { mergeAccepted } from './delivery/merge.js';
import { installationOf, installedBuild, packageRoot, packageVersion } from './install/installation.js';
import { planUpdate, runInstaller } from './install/update.js';
import { buildScorecard, renderScorecard } from './measure/report.js';
import { measureDispatches } from './measure/usage.js';
import { OrcaCli } from './orca/client.js';
import { createTask } from './pipeline/create-task.js';
import { removeTask, type RemoveOptions } from './pipeline/remove-task.js';
import { drive, driveReview } from './pipeline/driver.js';
import { headSha } from './git/git.js';
import { foldEvents } from './pipeline/state.js';
import { renderSummary, summarise, type TaskSummary } from './pipeline/status.js';
import { installSkill, renderSkill } from './skill.js';
import { withObservedStop } from './store/driver-lock.js';
import { listTaskIds, TaskStore } from './store/task-store.js';

const usage = usageText();

async function main(argv: string[]): Promise<number> {
  // `--version` is also approve's spec-version option, so the conventional bare form is matched first.
  if (argv.length === 1 && argv[0] === '--version') return version(false);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      repo: { type: 'string' },
      recipe: { type: 'string' },
      title: { type: 'string' },
      version: { type: 'string' },
      source: { type: 'string' },
      purpose: { type: 'string' },
      json: { type: 'boolean' },
      after: { type: 'string' },
      port: { type: 'string' },
      recipes: { type: 'string' },
      mode: { type: 'string' },
      delivery: { type: 'string' },
      'max-seconds': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'shared-tests': { type: 'boolean' },
      from: { type: 'string' },
      dirty: { type: 'boolean' },
      worktree: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(usage);
    return command ? 0 : 1;
  }
  const dataDir = values.home ? resolve(values.home) : dataDirectory();
  useSettings(loadSettings(dataDir));
  const source = values.source ?? 'cli';
  if (source !== 'cli' && source !== 'chat' && source !== 'dashboard') throw new Error(`Unknown --source ${source}.`);
  const purpose = commandPurpose(values.purpose);
  const queue = (taskId: string | undefined, body: CommandBody) =>
    queued(dataDir, taskId, source, { ...body, ...(purpose ? { purpose } : {}) });
  switch (command) {
    case 'new':
      return newTask(dataDir, rest, values);
    case 'dashboard':
      return dashboard(dataDir, values.port);
    case 'drive':
      return drive(TaskStore.open(dataDir, required(rest[0], 'task')), new OrcaCli(), line =>
        console.log(`[${time()}] ${line}`),
      );
    case 'drive-review':
      return driveReview(TaskStore.open(dataDir, required(rest[0], 'task')), new OrcaCli(), line =>
        console.log(`[${time()}] ${line}`),
      );
    case 'explain':
    case 'ask':
      return queueReview(dataDir, required(rest[0], 'task'), command, rest.slice(1).join(' '), source);
    default: {
      const handled =
        (await comparisonCommand(dataDir, command, rest, source, values)) ??
        (await otherCommand(dataDir, command, rest, values));
      if (handled !== null) return handled;
      const body = controlCommand(dataDir, command, rest, values.version);
      if (body) return queue(rest[0], body);
      console.error(usage);
      return 1;
    }
  }
}

/** Comparison commands; null for anything else. `abandon` with a comparison id abandons the comparison. */
async function comparisonCommand(
  dataDir: string,
  command: string,
  rest: string[],
  source: CommandSource,
  values: {
    repo?: string;
    recipes?: string;
    mode?: string;
    title?: string;
    delivery?: string;
    'max-seconds'?: string;
    'dry-run'?: boolean;
    'shared-tests'?: boolean;
  },
): Promise<number | null> {
  switch (command) {
    case 'compare':
      return compare(dataDir, rest, values);
    case 'drive-comparison':
      return driveComparison({
        dataDir,
        comparisonId: required(rest[0], 'comparison'),
        orca: new OrcaCli(),
        selfCommand: selfCommand(dataDir),
        log: line => console.log(`[${time()}] ${line}`),
      });
    case 'pick':
      return comparisonDecision(dataDir, required(rest[0], 'comparison'), source, {
        kind: 'pick',
        taskId: required(rest[1], 'task'),
      });
    case 'abandon': {
      const [id, ...words] = rest;
      if (!id || !listComparisonIds(dataDir).includes(id)) return null;
      const reason = words.join(' ');
      return comparisonDecision(dataDir, id, source, reason ? { kind: 'abandon', reason } : { kind: 'abandon' });
    }
    default:
      return null;
  }
}

/** Commands that read state or act outside a task's driver; null for a control verb or an unknown one. */
async function otherCommand(
  dataDir: string,
  command: string,
  rest: string[],
  values: { json?: boolean; after?: string; from?: string; dirty?: boolean; worktree?: boolean; force?: boolean },
): Promise<number | null> {
  switch (command) {
    case 'status':
      return status(dataDir, rest[0], values.json ?? false);
    case 'wait':
      return wait(dataDir, rest[0], values.after, values.json ?? false);
    case 'merge':
      return merge(dataDir, required(rest[0], 'task'));
    case 'remove':
      return remove(dataDir, required(rest[0], 'task'), {
        worktree: values.worktree ?? false,
        force: values.force ?? false,
      });
    case 'report':
      return report(dataDir, required(rest[0], 'task'), values.json ?? false);
    case 'explanation': {
      const events = TaskStore.open(dataDir, required(rest[0], 'task')).events();
      const state = foldEvents(events);
      const view = taskDetail(state, events, []);
      console.log(JSON.stringify({ explanations: view.explanations, answers: view.answers }, null, 2));
      return 0;
    }
    case 'recipes':
      console.log(JSON.stringify(availableRecipes(), null, 2));
      return 0;
    case 'skill':
      return skill(dataDir, rest[0] === 'install');
    case 'version':
      return version(values.json ?? false);
    case 'update':
      return update(values.from, values.dirty ?? false);
    default:
      return null;
  }
}

/** Queue a candidate-bound review request and reopen the short-lived review driver after completion. */
async function queueReview(
  dataDir: string,
  taskId: string,
  kind: 'explain' | 'ask',
  words: string,
  source: CommandSource,
): Promise<number> {
  const state = foldEvents(TaskStore.open(dataDir, taskId).events());
  const workspace = state.workspace;
  const specVersion = state.specs.at(-1)?.version;
  if (!workspace || !specVersion) throw new Error('The task has no worktree or spec to explain.');
  const candidateSha = await headSha(workspace.path);
  const binding = { baseSha: workspace.baseSha, candidateSha, specVersion };
  const body: CommandBody =
    kind === 'explain'
      ? { kind, ...binding }
      : { kind, ...binding, question: required(words, 'question'), groupId: null, reference: null };
  const command = queueCommand(dataDir, taskId, source, body);
  if (state.finished)
    await new OrcaCli().createTerminal({
      worktree: { id: workspace.worktreeId },
      title: `Grampus review: ${state.title}`,
      command: `${selfCommand(dataDir)} drive-review ${taskId}`,
    });
  console.log(`Queued ${command.kind} for ${taskId}. Read the stored result with grampus explanation ${taskId}.`);
  return 0;
}

/** Fast-forward the user's checked-out branch to an accepted task's verified commit. Never pushes. */
async function merge(dataDir: string, taskId: string): Promise<number> {
  const merged = await mergeAccepted(TaskStore.open(dataDir, taskId));
  console.log(
    merged.alreadyMerged
      ? `${merged.branch} already contains ${merged.sha.slice(0, 12)}; nothing to do.`
      : `Fast-forwarded ${merged.branch} to ${merged.sha.slice(0, 12)}. Nothing was pushed.`,
  );
  return 0;
}

/** Delete a task's folder, and its worktree when asked. Refused while its driver runs. */
async function remove(dataDir: string, taskId: string, options: RemoveOptions): Promise<number> {
  const removed = await removeTask(dataDir, taskId, options, new OrcaCli());
  const worktree = {
    removed: ` and its worktree ${removed.worktreePath}. Orca keeps the task branch unless it is merged`,
    'already-gone': `; its worktree ${removed.worktreePath} was already gone`,
    kept: `. Its worktree stays at ${removed.worktreePath}`,
    none: '',
  }[removed.worktree];
  console.log(`Removed ${taskId}${worktree}.`);
  return 0;
}

/** The command a control verb queues, or null for an unknown verb. */
function controlCommand(
  dataDir: string,
  verb: string,
  rest: string[],
  version: string | undefined,
): CommandBody | null {
  switch (verb) {
    case 'approve':
      return { kind: 'approve', specVersion: approvedVersion(dataDir, required(rest[0], 'task'), version) };
    case 'revise':
      return { kind: 'revise', feedback: required(rest.slice(1).join(' '), 'feedback') };
    case 'reply':
      return {
        kind: 'reply',
        messageId: required(rest[1], 'message id'),
        body: required(rest.slice(2).join(' '), 'answer'),
      };
    case 'continue':
      return { kind: 'continue', guidance: required(rest.slice(1).join(' '), 'guidance') };
    case 'retry':
    case 'accept':
      return { kind: verb };
    case 'abandon': {
      const reason = rest.slice(1).join(' ');
      return reason ? { kind: 'abandon', reason } : { kind: 'abandon' };
    }
    default:
      return null;
  }
}

function queued(dataDir: string, taskId: string | undefined, source: CommandSource, body: CommandBody): number {
  const command = queueCommand(dataDir, required(taskId, 'task'), source, body);
  console.log(
    `Queued ${command.kind} for ${taskId}. The task's driver applies it within a few seconds; check with \`grampus status ${taskId}\`.`,
  );
  return 0;
}

/** Start a comparison: one entry task per recipe, from the same base commit. */
async function compare(
  dataDir: string,
  words: string[],
  values: {
    repo?: string;
    recipes?: string;
    mode?: string;
    title?: string;
    delivery?: string;
    'max-seconds'?: string;
    'dry-run'?: boolean;
    'shared-tests'?: boolean;
  },
): Promise<number> {
  const mode = values.mode ?? 'shared';
  if (mode !== 'shared' && mode !== 'full') throw new Error(`--mode must be shared or full, not "${mode}".`);
  if (values['max-seconds'] && !values.delivery)
    throw new Error('--max-seconds requires --delivery so the common policy is explicit.');
  const delivery = values.delivery
    ? deliverySchema.parse({
        mode: values.delivery,
        ...(values['max-seconds'] ? { maxSeconds: Number(values['max-seconds']) } : {}),
      })
    : undefined;
  const names = required(values.recipes, '--recipes').split(',');
  if (values['shared-tests'] && mode !== 'shared') throw new Error('--shared-tests requires --mode shared.');
  console.log(comparisonPolicyPreview(comparisonRecipes(names, delivery, values['shared-tests'])));
  if (values['dry-run']) return 0;
  const created = await startComparison(
    {
      dataDir,
      repoPath: resolve(values.repo ?? process.cwd()),
      request: required(words.join(' '), 'request'),
      recipeNames: names,
      ...(delivery ? { delivery } : {}),
      ...(values['shared-tests'] ? { sharedTests: true } : {}),
      mode,
      ...(values.title ? { title: values.title } : {}),
      driveCommand: comparisonId => `${selfCommand(dataDir)} drive-comparison ${comparisonId}`,
    },
    new OrcaCli(),
  );
  console.log(
    `Created ${created.comparisonId} (${mode} mode).
  repository: ${created.repository}
  driver terminal: ${created.terminal}`,
  );
  console.log(
    mode === 'shared'
      ? 'The first entry writes the common spec. Each recipe follows its recorded approval policy. Pick a result when comparison finishes.'
      : 'Each entry writes its own spec and follows its recorded approval policy. When all are done, pick the one to keep.',
  );
  return 0;
}

function comparisonDecision(
  dataDir: string,
  comparisonId: string,
  source: CommandSource,
  body: { kind: 'pick'; taskId: string } | { kind: 'abandon'; reason?: string },
): number {
  queueComparisonCommand(dataDir, comparisonId, source, body);
  console.log(`Queued ${body.kind} for ${comparisonId}. Its driver applies it within a few seconds.`);
  return 0;
}

/** Serve the dashboard until the process is stopped. */
async function dashboard(dataDir: string, port: string | undefined): Promise<number> {
  const chosen = port === undefined ? currentSettings().dashboardPort : Number(port);
  if (!Number.isInteger(chosen) || chosen < 0) throw new Error(`--port must be a port number, not "${port}".`);
  const server = await serveDashboard({ dataDir, port: chosen, selfCommand: selfCommand(dataDir) });
  console.log('Grampus dashboard, reachable from this machine and your local network:');
  for (const url of server.urls) console.log(`  ${url}`);
  console.log('Anyone who can open these addresses can start and control tasks. Press Ctrl+C to stop.');
  await server.closed;
  return 0;
}

async function newTask(
  dataDir: string,
  words: string[],
  values: { repo?: string; recipe?: string; title?: string },
): Promise<number> {
  const asOf = new Date().toISOString();
  const created = await createTask(
    {
      dataDir,
      repoPath: resolve(values.repo ?? process.cwd()),
      request: required(words.join(' '), 'request'),
      ...(values.title ? { title: values.title } : {}),
      ...(values.recipe ? { recipeName: values.recipe } : {}),
      driveCommand: taskId => `${selfCommand(dataDir)} drive ${taskId}`,
    },
    new OrcaCli(),
  );
  console.log(
    `Created ${created.taskId}.\n  repository: ${created.repository}\n  worktree: ${created.worktree}\n  driver terminal: ${created.terminal}`,
  );
  console.log(
    'The task follows its recipe delivery policy. Use `grampus wait` for consequential questions and the result.',
  );
  console.log(`as of ${asOf}`);
  return 0;
}

/**
 * Print or install the chat skill. Only an installed build installs it, with `grampus` from PATH, so a
 * development checkout never replaces the skill people use.
 */
function skill(dataDir: string, install: boolean): number {
  const installed = installedBuild() !== null;
  const commandLine = installed ? chatCommand(dataDir) : selfCommand(dataDir);
  if (!install) {
    console.log(renderSkill(commandLine));
    return 0;
  }
  if (!installed)
    throw new Error(
      'This is a development checkout. Install Grampus with `npm run install:local`, which also installs the chat skill.',
    );
  for (const path of installSkill(commandLine)) console.log(`Installed ${path}`);
  return 0;
}

/** Install what is committed in the running build's checkout (or `--from`), unless it is already running. */
function update(from: string | undefined, allowDirty: boolean): number {
  const build = installedBuild();
  if (!build) throw new Error('This is a development checkout. Install it with `npm run install:local`.');
  const plan = planUpdate(build, from, allowDirty);
  if (plan.kind === 'current') {
    console.log(`Grampus ${plan.build} is already the latest commit in ${build.source}.`);
    return 0;
  }
  console.log(`Updating from ${plan.checkout} at ${plan.commit.slice(0, 12)}`);
  return runInstaller(plan.checkout, allowDirty);
}

/** The running build: an installed version and where it is installed, or a development checkout. */
function version(json: boolean): number {
  const build = installedBuild();
  const info = {
    version: build?.version ?? packageVersion(),
    build,
    installation: build ? installationOf(packageRoot) : null,
    root: packageRoot,
  };
  if (json) console.log(JSON.stringify(info, null, 2));
  else if (build)
    console.log(
      `Grampus ${build.build}, installed in ${info.installation} (built ${build.builtAt} from ${build.source})`,
    );
  else console.log(`Grampus ${info.version}, development checkout ${packageRoot}`);
  return 0;
}

/** A finished task's recorded scorecard, or a provisional one measured now for a running task. */
async function report(dataDir: string, taskId: string, json: boolean): Promise<number> {
  const events = TaskStore.open(dataDir, taskId).events();
  const state = foldEvents(events);
  const measurements = state.measurements ?? (await measureDispatches(state, new OrcaCli()));
  const card = buildScorecard(state, events, measurements);
  console.log(json ? JSON.stringify(card, null, 2) : renderScorecard(card));
  return 0;
}

/** Task summaries, counting a driver that went missing without recording why as stopped. */
function summaries(dataDir: string, taskId: string | undefined): TaskSummary[] {
  const ids = taskId ? [taskId] : listTaskIds(dataDir);
  return ids.map(id => {
    const store = TaskStore.open(dataDir, id);
    const events = store.events();
    return summarise(withObservedStop(foldEvents(events), store.dir, events));
  });
}

/** Comparisons, when no single task was asked for. */
function comparisons(dataDir: string, taskId: string | undefined): ComparisonSummary[] {
  return taskId ? [] : listComparisonIds(dataDir).map(id => summariseComparison(dataDir, id));
}

function status(dataDir: string, taskId: string | undefined, json: boolean): number {
  const asOf = new Date().toISOString();
  print(summaries(dataDir, taskId), comparisons(dataDir, taskId), asOf, json, 'No tasks.');
  return 0;
}

/**
 * Print summaries with the cursor they were read at. Passing that cursor to the next `wait --after`
 * reports anything that happened in between, such as a request raised while an agent talked to the user.
 */
function print(tasks: TaskSummary[], compared: ComparisonSummary[], asOf: string, json: boolean, empty: string): void {
  if (json) {
    console.log(JSON.stringify({ asOf, tasks, comparisons: compared }, null, 2));
    return;
  }
  const blocks = [...compared.map(renderComparison), ...tasks.map(renderSummary)];
  console.log(`${blocks.length ? blocks.join('\n\n') : empty}\nas of ${asOf}`);
}

/**
 * Block until a task has something newer than `after` for the user (a decision, a question, a stopped
 * driver or a finish), or the wait times out. Without `after`, only what happens from now on counts.
 */
async function wait(
  dataDir: string,
  taskId: string | undefined,
  after: string | undefined,
  json: boolean,
): Promise<number> {
  if (after !== undefined && Number.isNaN(Date.parse(after)))
    throw new Error(`--after must be a time printed by Grampus, not "${after}".`);
  const since = after ?? new Date().toISOString();
  const deadline = Date.now() + currentSettings().waitTimeoutSeconds * 1000;
  for (;;) {
    const asOf = new Date().toISOString();
    const fresh = summaries(dataDir, taskId).filter(summary => isNew(summary, since));
    const picks = comparisons(dataDir, taskId).filter(summary => isNewComparison(summary, since));
    if (fresh.length || picks.length || Date.now() >= deadline) {
      print(
        fresh,
        picks,
        asOf,
        json,
        `Nothing new needs you yet. Run \`grampus wait --after ${asOf}\` to keep waiting.`,
      );
      return 0;
    }
    await sleep(currentSettings().waitPollMs);
  }
}

function isNew(summary: TaskSummary, since: string): boolean {
  if (summary.needsYou && summary.needsYou.since > since) return true;
  if (summary.questions.some(question => question.at > since)) return true;
  if (summary.lastStop && !summary.finished && summary.lastStop.at > since) return true;
  // A finish confirms an accept or abandon the user asked for; whoever waits on it must hear it.
  if (summary.finished && summary.finished.at > since) return true;
  return false;
}

function isNewComparison(summary: ComparisonSummary, since: string): boolean {
  if (summary.needsYou && summary.needsYou.since > since) return true;
  if (summary.lastStop && summary.lastStop.at > since) return true;
  return Boolean(summary.finished && summary.finished.at > since);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing ${name}.\n\n${usage}`);
  return value;
}

function time(): string {
  return new Date().toLocaleTimeString();
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);

/** Optional correction attribution supplied by the user, never inferred from free text. */
function commandPurpose(value: string | undefined): 'implementation' | 'workflow' | undefined {
  if (value === undefined || value === 'implementation' || value === 'workflow') return value;
  throw new Error('Purpose must be implementation or workflow.');
}
