// Naming a task from its request with a small model, and falling back to the request's first line
// whenever that does not work. A script stands in for the Claude CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanTitle, suggestTitle } from '../src/agents/title.js';
import { loadSettings } from '../src/config/settings.js';
import { createTask } from '../src/pipeline/create-task.js';
import { foldEvents } from '../src/pipeline/state.js';
import { TaskStore } from '../src/store/task-store.js';
import { FakeOrca } from './helpers/fake-orca.js';
import { createRepository, useTestSettings } from './helpers/task-fixture.js';

/** A stand-in Claude CLI: answers only a print-mode call that names the model and sends the request on stdin. */
function fakeClaude(body: string): string[] {
  const script = join(mkdtempSync(join(tmpdir(), 'grampus-claude-')), 'claude.mjs');
  writeFileSync(
    script,
    `let input = '';
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  if (!args.includes('-p') || args[args.indexOf('--model') + 1] !== 'haiku') process.exit(2);
  ${body}
});
`,
  );
  return [process.execPath, script];
}

const request = 'Hi! Could you please make greet() say hello using the given name?\nThanks.';

test('a task without a title is named by the model, and the name shapes its id', async () => {
  useTestSettings({
    titleModel: 'haiku',
    claudeCommand: fakeClaude(`if (input.includes('greet() say hello')) console.log('"Greet people by name."');`),
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-title-'));
  const created = await createTask(
    { dataDir, repoPath: await createRepository(), request, driveCommand: id => `drive ${id}` },
    new FakeOrca(() => 'hang'),
  );
  assert.match(created.taskId, /^greet-people-by-name-[0-9a-f]{6}$/);
  assert.equal(foldEvents(TaskStore.open(dataDir, created.taskId).events()).title, 'Greet people by name');
});

test('a given title is kept without asking the model', async () => {
  useTestSettings({ titleModel: 'haiku', claudeCommand: fakeClaude(`process.exit(3);`) });
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-title-'));
  const created = await createTask(
    { dataDir, repoPath: await createRepository(), request, title: 'Greet', driveCommand: id => `drive ${id}` },
    new FakeOrca(() => 'hang'),
  );
  assert.match(created.taskId, /^greet-[0-9a-f]{6}$/);
});

test('naming falls back when it is off, fails, times out or answers nothing usable', async () => {
  useTestSettings({ titleModel: null, claudeCommand: fakeClaude(`console.log('Unused');`) });
  assert.equal(await suggestTitle(request), null);
  useTestSettings({ titleModel: 'haiku', claudeCommand: fakeClaude(`process.exit(1);`) });
  assert.equal(await suggestTitle(request), null);
  useTestSettings({
    titleModel: 'haiku',
    titleTimeoutMs: 200,
    claudeCommand: fakeClaude(`await new Promise(done => setTimeout(done, 10_000));`),
  });
  assert.equal(await suggestTitle(request), null);
  useTestSettings({ titleModel: 'haiku', claudeCommand: fakeClaude(`console.log('x'.repeat(500));`) });
  assert.equal(await suggestTitle(request), null);
  useTestSettings({ titleModel: 'haiku', claudeCommand: ['grampus-no-such-command'] });
  assert.equal(await suggestTitle(request), null);

  useTestSettings({ titleModel: 'haiku', claudeCommand: fakeClaude(`process.exit(1);`) });
  const dataDir = mkdtempSync(join(tmpdir(), 'grampus-title-'));
  const created = await createTask(
    { dataDir, repoPath: await createRepository(), request, driveCommand: id => `drive ${id}` },
    new FakeOrca(() => 'hang'),
  );
  assert.equal(
    foldEvents(TaskStore.open(dataDir, created.taskId).events()).title,
    'Hi! Could you please make greet() say hello using the given name?',
  );
});

test('answers are cleaned of labels, quotes, Markdown and full stops', () => {
  assert.equal(cleanTitle('\n  **Title: "Add CSV export."**  \nBecause...'), 'Add CSV export');
  assert.equal(cleanTitle('“Fix   login redirect”'), 'Fix login redirect');
  assert.equal(cleanTitle('   \n'), null);
});

test('a title model that cmd.exe could interpret is refused in config.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'grampus-title-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ titleModel: 'haiku & calc' }));
  assert.throws(() => loadSettings(home), /titleModel/);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ titleModel: 'claude-haiku-4-5[1m]' }));
  assert.equal(loadSettings(home).titleModel, 'claude-haiku-4-5[1m]');
});
