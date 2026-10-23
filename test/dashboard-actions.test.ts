// Dashboard actions beyond the command queue: starting a task, merging, Orca tabs, recipes and the model
// catalog. Each must do what the matching CLI command does, and refuse what it refuses.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseClaudeHelp, parseCodexCatalog } from '../src/agents/catalog.js';
import { ComparisonStore } from '../src/compare/comparison.js';
import { currentSettings } from '../src/config/settings.js';
import { serveDashboard, type RunningDashboard } from '../src/dashboard/server.js';
import { standardRecipe, standardClaudeRecipe } from '../src/domain/recipe.js';
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
  // Saving a recipe reloads settings from config.json; naming must stay off for the tasks started after.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ titleModel: null }));
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
  assert.deepEqual(state.recipe, standardRecipe, 'new tasks use standard-codex by default');
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

test('saved recipes preserve other settings and cannot replace either built-in recipe', async () => {
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
  const catalog = (await (await fetch(`${base}/api/recipes`)).json()) as {
    builtIn: string[];
    defaultRecipe: string;
    recipes: { name: string }[];
  };
  assert.deepEqual(catalog.builtIn, ['standard-codex', 'standard-claude', 'adaptive-codex', 'adaptive-claude']);
  assert.equal(catalog.defaultRecipe, 'standard-codex');
  assert.deepEqual(
    catalog.recipes.map(recipe => recipe.name),
    [...catalog.builtIn, 'cheaper'],
  );
  for (const name of catalog.builtIn) {
    assert.equal((await send(base, 'PUT', `/api/recipes/${name}`, { ...cheap, name })).status, 400);
    assert.equal((await send(base, 'PUT', '/api/recipes/cheaper', { ...cheap, name })).status, 400);
    assert.equal((await send(base, 'DELETE', `/api/recipes/${name}`, {})).status, 404);
  }
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

test('removing a task from the dashboard does what grampus remove does, refusals included', async () => {
  const { home, base } = await start();
  const store = taskIn(home, 'C:/code/alpha');
  const unfinished = await send(base, 'DELETE', '/api/tasks/task-1', { worktree: false, force: false });
  assert.equal(unfinished.status, 409);
  assert.match(await unfinished.text(), /has not finished/);

  store.append({ type: 'task.finished', outcome: 'abandoned', sha: null, override: false, reason: null });
  const removed = await send(base, 'DELETE', '/api/tasks/task-1', { worktree: false, force: false });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual(await removed.json(), { taskId: 'task-1', worktree: 'kept', worktreePath: join(home, 'wt') });
  assert.equal(existsSync(store.dir), false);
  assert.equal((await fetch(`${base}/api/tasks/task-1`)).status, 404);
  assert.equal((await send(base, 'DELETE', '/api/tasks/task-1', { worktree: false, force: false })).status, 404);
});

test('open in Orca brings the driver terminal or the changed files forward', async () => {
  const { home, base, orca } = await start();
  taskIn(home, 'C:/code/alpha');
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/open', { target: 'terminal' })).status, 200);
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/open', { target: 'changes' })).status, 200);
  assert.deepEqual(orca.opened, ['terminal:term_1', `changes:${join(home, 'wt')}`]);
  assert.equal((await send(base, 'POST', '/api/tasks/missing/open', { target: 'terminal' })).status, 404);
});

test('a stopped driver is resumed in a new terminal, and its dead tab is closed', async () => {
  const { home, base, orca } = await start();
  const store = taskIn(home, 'C:/code/alpha');
  orca.titles.set('term_1', 'Grampus: T');
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/resume', {})).status, 409, 'a new task gets time to start');

  store.append({ type: 'driver.stopped', reason: 'Orca stayed busy.' });
  orca.nextTerminals = ['term_2'];
  const response = await send(base, 'POST', '/api/tasks/task-1/resume', {});
  assert.equal(response.status, 202, await response.clone().text());
  assert.deepEqual(orca.terminals, ['grampus-test drive task-1']);
  assert.deepEqual(orca.terminalPlaces, ['id:wt1'], 'in the task worktree');
  assert.deepEqual(orca.closed, ['term_1']);
  const again = await send(base, 'POST', '/api/tasks/task-1/resume', {});
  assert.equal(again.status, 409, 'a second click does not start a second driver');
  assert.match(await again.text(), /already resuming/);

  // The resumed driver records its tab, which is the one shown and closed from then on.
  store.append({ type: 'driver.started', pid: 1, orcaVersion: null, terminal: 'term_2' });
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/open', { target: 'terminal' })).status, 200);
  assert.deepEqual(orca.opened, ['terminal:term_2']);
});

test('resuming never closes a terminal Grampus did not open', async () => {
  const { home, base, orca } = await start();
  const store = taskIn(home, 'C:/code/alpha');
  // Someone ran grampus drive in their own terminal; that driver stopped.
  orca.titles.set('term_mine', 'pwsh');
  store.append({ type: 'driver.started', pid: 1, orcaVersion: null, terminal: 'term_mine' });
  store.append({ type: 'driver.stopped', reason: 'Orca stayed busy.' });
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/resume', {})).status, 202);
  assert.deepEqual(orca.closed, []);

  store.append({ type: 'task.finished', outcome: 'abandoned', sha: null, override: false, reason: null });
  assert.equal((await send(base, 'POST', '/api/tasks/task-1/resume', {})).status, 409, 'a finished task has no driver');
});

test('a stopped comparison driver is resumed in the main checkout', async () => {
  const { home, base, orca } = await start();
  const store = ComparisonStore.create(home, 'cmp-greet-1');
  store.append({
    type: 'comparison.created',
    comparisonId: 'cmp-greet-1',
    title: 'Greet',
    request: 'Greet by name',
    repoPath: 'C:/code/alpha',
    mode: 'full',
    recipes: [standardRecipe, { ...standardRecipe, name: 'alt' }],
    concurrency: 2,
  });
  store.append({ type: 'comparison.terminal', terminal: 'term_cmp' });
  orca.titles.set('term_cmp', 'Grampus comparison: Greet');
  store.append({ type: 'driver.stopped', reason: 'Unexpected error.' });
  orca.nextTerminals = ['term_cmp_2'];
  const response = await send(base, 'POST', '/api/comparisons/cmp-greet-1/resume', {});
  assert.equal(response.status, 202, await response.clone().text());
  assert.deepEqual(orca.terminals, ['grampus-test drive-comparison cmp-greet-1']);
  assert.deepEqual(orca.terminalPlaces, ['path:C:/code/alpha']);
  assert.deepEqual(orca.closed, ['term_cmp']);
  assert.equal((await send(base, 'POST', '/api/comparisons/missing/resume', {})).status, 404);
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
  const alt = { ...standardClaudeRecipe, name: 'alt' };
  assert.equal((await send(base, 'PUT', '/api/recipes/alt', alt)).status, 201);
  const tooFew = await send(base, 'POST', '/api/comparisons', {
    repo,
    request: 'Greet',
    recipes: ['standard-codex'],
    mode: 'full',
  });
  assert.equal(tooFew.status, 400);
  const response = await send(base, 'POST', '/api/comparisons', {
    repo,
    request: 'Greet by name',
    recipes: ['standard-codex', 'alt'],
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
  assert.deepEqual([detail.mode, detail.waiting, detail.status], ['shared', ['standard-codex', 'alt'], 'running']);
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
