#!/usr/bin/env node
// The `grampus` command line. Every control action is a command queued for the task's driver, so the
// CLI, an Orca chat agent using the Grampus skill and the dashboard all control tasks the same way.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { dataDirectory } from './config/paths.js';
import { availableRecipes, currentSettings, loadSettings, useSettings } from './config/settings.js';
import type { UserCommand } from './domain/events.js';
import { buildScorecard, renderScorecard } from './measure/report.js';
import { measureDispatches } from './measure/usage.js';
import { OrcaCli } from './orca/client.js';
import { createTask } from './pipeline/create-task.js';
import { drive } from './pipeline/driver.js';
import { foldEvents } from './pipeline/state.js';
import { renderSummary, summarise, type TaskSummary } from './pipeline/status.js';
import { installSkill, renderSkill } from './skill.js';
import { listTaskIds, TaskStore } from './store/task-store.js';

const usage = `Usage: grampus <command> [options]

  new --repo <path> [--recipe <name>] [--title <text>] <request...>   Start a task in a new Orca worktree
  status [task] [--json]                                              Show tasks, or one task in detail
  wait [task] [--json]                                                Block until something new needs you
  report <task> [--json]                                              Models, time and tokens per stage, and human cost
  approve <task> [--version <n>]                                      Approve the latest (or given) spec version
  revise <task> <feedback...>                                         Ask the spec writer for a revision
  reply <task> <message-id> <answer...>                               Answer a worker's question
  continue <task> <guidance...>                                       Run another repair round with guidance
  retry <task>                                                        Retry a stage that failed to start or exited
  accept <task>                                                       Accept the task's verified branch
  abandon <task> [reason...]                                          Abandon the task and release its workers
  drive <task>                                                        Run a task's driver (Grampus starts it in Orca)
  recipes                                                             List recipes
  skill [install]                                                     Print the chat skill, or install it for Claude and Codex

Options: --home <dir> (data directory), --source cli|chat|dashboard (who is acting; default cli)`;

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
  const queue = (taskId: string | undefined, body: CommandBody) => queueCommand(dataDir, taskId, source, body);
  switch (command) {
    case 'new':
      return newTask(dataDir, rest, values);
    case 'drive':
      return drive(TaskStore.open(dataDir, required(rest[0], 'task')), new OrcaCli(), line =>
        console.log(`[${time()}] ${line}`),
      );
    case 'status':
      return status(dataDir, rest[0], values.json ?? false);
    case 'wait':
      return wait(dataDir, rest[0], values.json ?? false);
    case 'report':
      return report(dataDir, required(rest[0], 'task'), values.json ?? false);
    case 'recipes':
      console.log(JSON.stringify(availableRecipes(), null, 2));
      return 0;
    case 'skill':
      return skill(selfCommand(dataDir), rest[0] === 'install');
    default: {
      const body = controlCommand(dataDir, command, rest, values.version);
      if (body) return queue(rest[0], body);
      console.error(usage);
      return 1;
    }
  }
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

type CommandBody = DistributiveOmit<UserCommand, 'id' | 'at' | 'source'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function queueCommand(
  dataDir: string,
  taskId: string | undefined,
  source: 'cli' | 'chat' | 'dashboard',
  body: CommandBody,
): number {
  const store = TaskStore.open(dataDir, required(taskId, 'task'));
  const command = { ...body, id: randomUUID(), at: new Date().toISOString(), source } as UserCommand;
  store.addCommand(command);
  console.log(
    `Queued ${command.kind} for ${taskId}. The task's driver applies it within a few seconds; check with \`grampus status ${taskId}\`.`,
  );
  return 0;
}

async function newTask(
  dataDir: string,
  words: string[],
  values: { repo?: string; recipe?: string; title?: string },
): Promise<number> {
  const created = await createTask(
    {
      dataDir,
      repoPath: resolve(required(values.repo, '--repo')),
      request: required(words.join(' '), 'request'),
      ...(values.title ? { title: values.title } : {}),
      ...(values.recipe ? { recipeName: values.recipe } : {}),
      driveCommand: taskId => `${selfCommand(dataDir)} drive ${taskId}`,
    },
    new OrcaCli(),
  );
  console.log(`Created ${created.taskId}.\n  worktree: ${created.worktree}\n  driver terminal: ${created.terminal}`);
  console.log('The spec writer starts shortly; discuss the request with it in its Orca chat.');
  return 0;
}

/** The command line that runs this CLI against this data directory, for terminals and skills. */
function selfCommand(dataDir: string): string {
  return `node "${resolve(process.argv[1] ?? '')}" --home "${dataDir}"`;
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

function status(dataDir: string, taskId: string | undefined, json: boolean): number {
  const all = summaries(dataDir, taskId);
  if (json) console.log(JSON.stringify(taskId ? all[0] : all, null, 2));
  else console.log(all.length ? all.map(renderSummary).join('\n\n') : 'No tasks.');
  return 0;
}

/** Block until a task newly needs the user (a decision, a question or a finish), or the wait times out. */
async function wait(dataDir: string, taskId: string | undefined, json: boolean): Promise<number> {
  const started = new Date().toISOString();
  const deadline = Date.now() + currentSettings().waitTimeoutSeconds * 1000;
  for (;;) {
    const fresh = summaries(dataDir, taskId).filter(summary => isNew(summary, started));
    if (fresh.length) {
      console.log(json ? JSON.stringify(fresh, null, 2) : fresh.map(renderSummary).join('\n\n'));
      return 0;
    }
    if (Date.now() >= deadline) {
      console.log(json ? '[]' : 'Nothing new needs you yet. Run `grampus wait` again to keep waiting.');
      return 0;
    }
    await sleep(currentSettings().waitPollMs);
  }
}

function isNew(summary: TaskSummary, since: string): boolean {
  if (summary.needsYou && summary.needsYou.since > since) return true;
  if (summary.questions.some(question => question.at > since)) return true;
  if (summary.lastStop && !summary.finished && summary.lastStop.at > since) return true;
  return false;
}

function approvedVersion(dataDir: string, taskId: string, version: string | undefined): number {
  if (version) return Number(version);
  const latest = foldEvents(TaskStore.open(dataDir, taskId).events()).specs.at(-1);
  if (!latest) throw new Error(`Task ${taskId} has no spec yet.`);
  return latest.version;
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
