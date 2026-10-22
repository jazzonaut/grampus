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
import { driveComparison } from './compare/driver.js';
import { renderComparison, summariseComparison, type ComparisonSummary } from './compare/status.js';
import {
  approvedVersion,
  queueCommand,
  queueComparisonCommand,
  selfCommand,
  type CommandBody,
  type CommandSource,
} from './control.js';
import { serveDashboard } from './dashboard/server.js';
import { mergeAccepted } from './delivery/merge.js';
import { buildScorecard, renderScorecard } from './measure/report.js';
import { measureDispatches } from './measure/usage.js';
import { OrcaCli } from './orca/client.js';
import { createTask } from './pipeline/create-task.js';
import { drive } from './pipeline/driver.js';
import { foldEvents } from './pipeline/state.js';
import { renderSummary, summarise, type TaskSummary } from './pipeline/status.js';
import { installSkill, renderSkill } from './skill.js';
import { listTaskIds, TaskStore } from './store/task-store.js';

const usage = usageText();

async function main(argv: string[]): Promise<number> {
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
      json: { type: 'boolean' },
      after: { type: 'string' },
      port: { type: 'string' },
      recipes: { type: 'string' },
      mode: { type: 'string' },
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
  const queue = (taskId: string | undefined, body: CommandBody) => queued(dataDir, taskId, source, body);
  switch (command) {
    case 'new':
      return newTask(dataDir, rest, values);
    case 'dashboard':
      return dashboard(dataDir, values.port);
    case 'drive':
      return drive(TaskStore.open(dataDir, required(rest[0], 'task')), new OrcaCli(), line =>
        console.log(`[${time()}] ${line}`),
      );
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
  values: { repo?: string; recipes?: string; mode?: string; title?: string },
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
  values: { json?: boolean; after?: string },
): Promise<number | null> {
  switch (command) {
    case 'status':
      return status(dataDir, rest[0], values.json ?? false);
    case 'wait':
      return wait(dataDir, rest[0], values.after, values.json ?? false);
    case 'merge':
      return merge(dataDir, required(rest[0], 'task'));
    case 'report':
      return report(dataDir, required(rest[0], 'task'), values.json ?? false);
    case 'recipes':
      console.log(JSON.stringify(availableRecipes(), null, 2));
      return 0;
    case 'skill':
      return skill(selfCommand(dataDir), rest[0] === 'install');
    default:
      return null;
  }
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
  values: { repo?: string; recipes?: string; mode?: string; title?: string },
): Promise<number> {
  const mode = values.mode ?? 'full';
  if (mode !== 'shared' && mode !== 'full') throw new Error(`--mode must be shared or full, not "${mode}".`);
  const created = await startComparison(
    {
      dataDir,
      repoPath: resolve(values.repo ?? process.cwd()),
      request: required(words.join(' '), 'request'),
      recipeNames: required(values.recipes, '--recipes').split(','),
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
      ? 'The first entry writes the spec; after you approve it, the other entries build from it.'
      : 'Each entry writes its own spec, so you approve one per recipe. When all are done, pick the one to keep.',
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
  console.log('The spec writer starts shortly. Its questions and the spec come to you through `grampus wait`.');
  console.log(`as of ${asOf}`);
  return 0;
}

function skill(commandLine: string, install: boolean): number {
  if (!install) {
    console.log(renderSkill(commandLine));
    return 0;
  }
  for (const path of installSkill(commandLine)) console.log(`Installed ${path}`);
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

function summaries(dataDir: string, taskId: string | undefined): TaskSummary[] {
  const ids = taskId ? [taskId] : listTaskIds(dataDir);
  return ids.map(id => summarise(foldEvents(TaskStore.open(dataDir, id).events())));
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
