// Dashboard actions beyond the command queue: starting a task, merging, Orca tabs, recipes and the model
// catalog. Each must do what the matching CLI command does, and refuse what it refuses.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseClaudeHelp, parseCodexCatalog } from '../src/agents/catalog.js';
import { currentSettings } from '../src/config/settings.js';
import { serveDashboard, type RunningDashboard } from '../src/dashboard/server.js';
import { standardRecipe } from '../src/domain/recipe.js';
import { foldEvents } from '../src/pipeline/state.js';
import { TaskStore } from '../src/store/task-store.js';
import { FakeOrca } from './helpers/fake-orca.js';
import { createRepository, useTestSettings } from './helpers/task-fixture.js';

const running: RunningDashboard[] = [];
after(async () => {
  for (const server of running) await server.close();
});

async function start(): Promise<{ home: string; base: string; orca: FakeOrca }> {
  useTestSettings({ waitPollMs: 20 });
  const home = mkdtempSync(join(tmpdir(), 'grampus-actions-'));
  const orca = new FakeOrca(() => 'hang');
  const server = await serveDashboard({ dataDir: home, port: 0, selfCommand: 'grampus-test', webRoot: home, orca });
  running.push(server);
  return { home, base: `http://localhost:${server.port}`, orca };
}

function send(base: string, method: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body),
  });
}

function taskIn(home: string, repoPath: string, taskId = 'task-1'): TaskStore {
  const store = TaskStore.create(home, taskId);
  store.append({ type: 'task.created', taskId, title: 'T', request: 'R', repoPath, recipe: standardRecipe });
  store.append({
    type: 'workspace.created',
    worktreeId: 'wt1',
    path: join(home, 'wt'),
    baseSha: 'abc',
    driverTerminal: 'term_1',
  });
  return store;
}

test('starting a task from the dashboard creates its log, worktree and driver terminal like grampus new', async () => {
  const { home, base, orca } = await start();
  const repo = await createRepository();
  const response = await send(base, 'POST', '/api/tasks', { repo, request: 'Greet by name', title: 'Greet' });
  assert.equal(response.status, 201, await response.clone().text());
  const created = (await response.json()) as { taskId: string };
  const state = foldEvents(TaskStore.open(home, created.taskId).events());
  assert.equal(state.title, 'Greet');
  assert.ok(state.workspace, 'the worktree is recorded');
  assert.deepEqual(orca.terminals, [`grampus-test drive ${created.taskId}`]);
});

test('a task with an unknown recipe is refused before anything is created', async () => {
  const { home, base } = await start();
  const repo = await createRepository();
  const response = await send(base, 'POST', '/api/tasks', { repo, request: 'Greet', recipe: 'nope' });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown recipe/);
  assert.equal(existsSync(join(home, 'tasks')), false);
});

test('recipes are saved to config.json beside other settings, validated, and the built-in one is protected', async () => {
  const { home, base } = await start();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ waitPollMs: 20 }));
  const cheap = { ...standardRecipe, name: 'cheap', build: { agent: 'codex', model: 'gpt-6-luna', effort: 'low' } };
  assert.equal((await send(base, 'PUT', '/api/recipes/cheap', cheap)).status, 201);
  const file = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
    waitPollMs: number;
    recipes: { name: string }[];
  };
  assert.equal(file.waitPollMs, 20, 'other settings are kept');
  assert.deepEqual(
    file.recipes.map(recipe => recipe.name),
    ['cheap'],
  );
  assert.ok(
    currentSettings().recipes.some(recipe => recipe.name === 'cheap'),
    'the dashboard uses it at once',
  );

  const renamed = await send(base, 'PUT', '/api/recipes/cheap', { ...cheap, name: 'cheaper' });
  assert.equal(renamed.status, 200);
  const effortWithoutModel = { ...cheap, build: { agent: 'codex', effort: 'low' } };
  assert.equal((await send(base, 'PUT', '/api/recipes/cheaper', effortWithoutModel)).status, 400);
  assert.equal((await send(base, 'PUT', '/api/recipes/standard', standardRecipe)).status, 400);
  assert.equal((await send(base, 'DELETE', '/api/recipes/cheaper', {})).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).recipes, []);
});

test('repositories list recent ones first, then the rest Orca knows, without duplicates', async () => {
  const { home, base, orca } = await start();
  taskIn(home, 'C:/code/alpha');
  orca.repos = [
    { id: 'r1', path: 'C:\\code\\alpha', name: 'alpha' },
    { id: 'r2', path: 'C:/code/beta', name: 'beta' },
  ];
  const { repos } = (await (await fetch(`${base}/api/repos`)).json()) as { repos: { path: string; recent: boolean }[] };
  assert.deepEqual(
    repos.map(repo => [repo.path, repo.recent]),
    [
      ['C:/code/alpha', true],
      ['C:/code/beta', false],
    ],
  );
});

test('open in Orca brings the driver terminal or the changed files forward', async () => {
  const { home, base, orca } = await start();
  taskIn(home, 'C:/code/alpha');
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/open', { target: 'terminal' })).status, 200);
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/open', { target: 'changes' })).status, 200);
  assert.deepEqual(orca.opened, ['terminal:term_1', `changes:${join(home, 'wt')}`]);
  assert.equal((await send(base, 'POST', '/api/tasks/missing/open', { target: 'terminal' })).status, 404);
});

test('merge refuses a task that was not accepted', async () => {
  const { home, base } = await start();
  taskIn(home, await createRepository());
  const response = await send(base, 'POST', '/api/tasks/task-1/merge', {});
  assert.equal(response.status, 409);
});

test('the Codex catalog lists visible models with their effort levels', () => {
  const models = parseCodexCatalog(
    JSON.stringify({
      models: [
        {
          slug: 'gpt-a',
          display_name: 'GPT A',
          visibility: 'list',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        },
        { slug: 'hidden', visibility: 'hide' },
      ],
    }),
  );
  assert.deepEqual(models, [{ id: 'gpt-a', label: 'GPT A', efforts: ['low', 'high'], defaultEffort: 'medium' }]);
});

test("Claude's aliases and effort levels are read from its help, and an unexpected text gives empty lists", () => {
  const help = `  --effort <level>     Effort level for the current session
                       (low, medium, high, xhigh, max)
  --model <model>      Model for the current session. Provide
                       an alias for the latest model (e.g.
                       'fable', 'opus', or 'sonnet') or a
                       model's full name.`;
  assert.deepEqual(parseClaudeHelp(help), {
    aliases: ['fable', 'opus', 'sonnet'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  });
  assert.deepEqual(parseClaudeHelp('Usage: claude [options]'), { aliases: [], efforts: [] });
});

test('a comparison started from the dashboard gets its log and a driver terminal in the main checkout', async () => {
  const { base, orca } = await start();
  const repo = await createRepository();
  const alt = { ...standardRecipe, name: 'alt', build: { agent: 'claude' } };
  assert.equal((await send(base, 'PUT', '/api/recipes/alt', alt)).status, 201);
  const tooFew = await send(base, 'POST', '/api/comparisons', {
    repo,
    request: 'Greet',
    recipes: ['standard'],
    mode: 'full',
  });
  assert.equal(tooFew.status, 400);
  const response = await send(base, 'POST', '/api/comparisons', {
    repo,
    request: 'Greet by name',
    recipes: ['standard', 'alt'],
    mode: 'shared',
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { comparisonId } = (await response.json()) as { comparisonId: string };
  assert.match(orca.terminals.at(-1) ?? '', new RegExp(`drive-comparison ${comparisonId}$`));
  assert.match(orca.terminalPlaces.at(-1) ?? '', /^path:/);

  const detail = (await (await fetch(`${base}/api/comparisons/${comparisonId}`)).json()) as {
    mode: string;
    waiting: string[];
    status: string;
  };
  assert.deepEqual([detail.mode, detail.waiting, detail.status], ['shared', ['standard', 'alt'], 'running']);
  const list = (await (await fetch(`${base}/api/comparisons`)).json()) as { comparisons: { comparisonId: string }[] };
  assert.deepEqual(
    list.comparisons.map(item => item.comparisonId),
    [comparisonId],
  );

  const badPick = await send(base, 'POST', `/api/comparisons/${comparisonId}/commands`, { kind: 'pick' });
  assert.equal(badPick.status, 400, 'a pick without a task is refused before it is queued');
  const pick = await send(base, 'POST', `/api/comparisons/${comparisonId}/commands`, { kind: 'abandon' });
  assert.equal(pick.status, 202);
  assert.equal((await send(base, 'POST', '/api/comparisons/missing/commands', { kind: 'abandon' })).status, 404);
});
