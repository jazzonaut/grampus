// Test fixtures: a real temporary Git repository with a small project, a data directory, and helpers
// that play the user (queueing commands) and the workers (writing specs, code and reports).
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultSettings, useSettings, type Settings } from '../../src/config/settings.js';
import type { UserCommand } from '../../src/domain/events.js';
import { standardRecipe, type Recipe } from '../../src/domain/recipe.js';
import { git } from '../../src/git/git.js';
import { createTask } from '../../src/pipeline/create-task.js';
import { drive } from '../../src/pipeline/driver.js';
import { foldEvents, type TaskState } from '../../src/pipeline/state.js';
import { TaskStore } from '../../src/store/task-store.js';
import { FakeOrca, type Behaviour } from './fake-orca.js';

/** Fast settings for driver tests. */
export function useTestSettings(overrides: Partial<Settings> = {}): void {
  useSettings({
    ...defaultSettings(),
    inboxWaitMs: 10,
    livenessIntervalMs: 30,
    waitPollMs: 10,
    orcaRetries: 2,
    orcaRetryDelayMs: 5,
    driverHeartbeatMs: 20,
    ...overrides,
  });
}

export const checkCommand = 'node test/greet.test.js';

/** A repository whose check fails until `greet.js` returns `Hello, <name>!`. */
export async function createRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'grampus-repo-'));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  write(root, 'greet.js', "export function greet(name) {\n  return 'Hi';\n}\n");
  write(root, 'package.json', '{"type": "module"}\n');
  write(
    root,
    'test/greet.test.js',
    "import { greet } from '../greet.js';\nif (greet('Ada') !== 'Hello, Ada!') { console.error('greet failed: ' + greet('Ada')); process.exit(1); }\nconsole.log('ok');\n",
  );
  await commitAll(root, 'Initial commit');
  return root;
}

export function write(root: string, path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

export async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', message]);
}

/** The task worktree, where every worker runs. */
export function worktreeOf(harness: Harness): string {
  const path = harness.state().workspace?.path;
  if (!path) throw new Error('The task has no worktree yet.');
  return path;
}

/** Extract the file a prompt asks the worker to write (`... to <path>.` or `... at <path>.`). */
export function outputPath(spec: string): string {
  const match = /(?:request|report) to (\S+?(?:spec\.md|report\.json))/.exec(spec);
  if (!match?.[1]) throw new Error(`No output path in prompt:\n${spec}`);
  return match[1];
}

export function specText(checks = [{ name: 'greet', command: checkCommand }], protectedPaths: string[] = []): string {
  return `# Greet by name\n## Outcome\nGreet people by name.\n## Acceptance criteria\n1. greet('Ada') returns 'Hello, Ada!'\n\n\`\`\`grampus\n${JSON.stringify({ checks, protected: protectedPaths })}\n\`\`\`\n`;
}

export function reviewJson(verdict: 'approve' | 'changes' | 'unknown', findings: unknown[] = []): string {
  return JSON.stringify({ verdict, summary: 'Reviewed.', findings });
}

export interface Harness {
  dataDir: string;
  repo: string;
  taskId: string;
  orca: FakeOrca;
  store: TaskStore;
  state(): TaskState;
  /** Start the driver; resolves with its exit code. */
  run(): Promise<number>;
  command(body: Record<string, unknown> & { kind: UserCommand['kind'] }): void;
  until(predicate: (state: TaskState) => boolean, what: string): Promise<TaskState>;
  log: string[];
}

/** Create a task with a fake Orca whose workers follow `behaviour`. */
export async function createHarness(
  behaviour: (harness: Harness) => Behaviour,
  recipe: Recipe = standardRecipe,
): Promise<Harness> {
  useTestSettings({ recipes: recipe.name === standardRecipe.name ? [] : [recipe] });
  const repo = await createRepository();
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-data-'));
  const log: string[] = [];
  const harness = {} as Harness;
  const orca = new FakeOrca(context => behaviour(harness)(context));
  const created = await createTask(
    {
      dataDir,
      repoPath: repo,
      request: 'Make greet say hello by name.',
      recipeName: recipe.name,
      driveCommand: id => `drive ${id}`,
    },
    orca,
  );
  const store = TaskStore.open(dataDir, created.taskId);
  Object.assign(harness, {
    dataDir,
    repo,
    taskId: created.taskId,
    orca,
    store,
    log,
    state: () => foldEvents(store.events()),
    run: () => drive(TaskStore.open(dataDir, created.taskId), harness.orca, line => log.push(line)),
    command: body =>
      store.addCommand({ ...body, id: randomUUID(), at: new Date().toISOString(), source: 'cli' } as UserCommand),
    until: async (predicate, what) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const state = harness.state();
        if (predicate(state)) return state;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Log:\n${log.join('\n')}`);
        await sleep(10);
      }
    },
  } satisfies Partial<Harness>);
  return harness;
}

/** Workers that do the right thing: write a valid spec, approve reviews, implement greet correctly. */
export function goodWorkers(harness: Harness, overrides: Partial<Record<string, Behaviour>> = {}): Behaviour {
  return async context => {
    const role = roleOf(context.title);
    const override = overrides[role];
    if (override) return override(context);
    const worktree = worktreeOf(harness);
    switch (role) {
      case 'spec':
        writeFileSync(outputPath(context.spec), specText());
        return { outcome: 'succeeded' };
      case 'spec-review':
      case 'review':
      case 'simplify-review':
        writeFileSync(outputPath(context.spec), reviewJson('approve'));
        return { outcome: 'succeeded' };
      case 'build':
      case 'repair':
        // Each dispatch commits something new, as a real repair would.
        write(
          worktree,
          'greet.js',
          `// ${context.dispatchId}\nexport function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n`,
        );
        await commitAll(worktree, 'Greet by name');
        return { outcome: 'succeeded' };
      default:
        return { outcome: 'succeeded' };
    }
  };
}

/** The pipeline role of an Orca task, from the title Grampus gives it. */
export function roleOf(title: string): string {
  if (title.startsWith('Spec review')) return 'spec-review';
  if (title.startsWith('Spec')) return 'spec';
  if (title.startsWith('Acceptance tests')) return 'tests';
  if (title.startsWith('Build')) return 'build';
  if (title.startsWith('Repair')) return 'repair';
  if (title.startsWith('Review')) return 'review';
  if (title.startsWith('Simplify review')) return 'simplify-review';
  if (title.startsWith('Simplify')) return 'simplify';
  return 'other';
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
