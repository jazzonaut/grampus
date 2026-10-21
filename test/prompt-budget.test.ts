// Prompt budget tests: every provider turn fits one shared budget, whatever the repository holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotRepository } from '../src/repository/artifacts.js';
import { repositoryContext } from '../src/repository/repository-evidence.js';
import { implementationTurn } from '../src/execution/implementation-prompt.js';
import { defaultSettings, useSettings } from '../src/config/settings.js';
import { prepareEditing, type EditingContext } from '../src/execution/edit-policy.js';
import { PromptBudget, PromptBudgetError, requirePromptBudget } from '../src/providers/prompt-budget.js';
import { promptLimits } from '../src/config/limits.js';
import type { GuidedPlan } from '../src/domain/guided-plan.js';
import type { Provider } from '../src/providers/types.js';

/** Codex app-server refuses turn input longer than this many characters. */
const codexInputCharacters = 1_048_576;

const files = Array.from({ length: 8 }, (_, index) => `docs/page-${index}.md`);
const edited = (path: string) => `# ${path} (edited)`;

/**
 * A repository whose base commit holds eight 120 KiB documents, all since edited, as after a first
 * attempt: a repair then starts with changed files, their diffs and, for Codex, the same editable files.
 */
async function editedRepository(t: { after(fn: () => void): void }) {
  const repo = mkdtempSync(join(tmpdir(), 'grampus-budget-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@invalid');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'AGENTS.md'), 'Follow existing patterns.\n');
  mkdirSync(join(repo, 'docs'));
  for (const path of files) writeFileSync(join(repo, path), `# ${path}\n${'Planned work item.\n'.repeat(6800)}`);
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const base = git('rev-parse', 'HEAD');
  // Two edits stay small enough to inline; the rest must be read through the repository tools.
  files.forEach((path, index) =>
    writeFileSync(join(repo, path), `${edited(path)}\n${'Done work item.\n'.repeat(index < 2 ? 1000 : 7500)}`),
  );
  const snapshot = await snapshotRepository(repo, base);
  const editing: EditingContext = {
    cwd: repo,
    snapshot,
    policy: { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files },
  };
  prepareEditing(editing);
  return { repo, editing };
}

const context = (exploration: boolean): GuidedPlan['context'] => ({
  files: ['AGENTS.md'],
  exploration,
  inventoryDigest: 'fixture',
  totalFiles: 0,
  totalBytes: 0,
});

function repairTurn(repo: string, editing: EditingContext, provider: Provider, exploration = true) {
  return implementationTurn(
    'Repair the failing validation.',
    { provider, providerSessionId: null, cwd: repo },
    editing,
    context(exploration),
  );
}

const occurrences = (text: string, marker: string) => text.split(marker).length - 1;

test('optional on-demand initial context preserves authorisation and instructions without eagerly copying editable text', async t => {
  const { repo, editing } = await editedRepository(t);
  useSettings({ ...defaultSettings(), deferEditableContext: false });
  const original = repairTurn(repo, editing, 'codex').prompt;
  useSettings({ ...defaultSettings(), deferEditableContext: true });
  try {
    const prompt = repairTurn(repo, editing, 'codex').prompt;
    assert.ok(Buffer.byteLength(prompt) < Buffer.byteLength(original));
    assert.match(prompt, /Authorized existing editable files/);
    assert.match(prompt, /Repository instructions/);
    assert.ok(!prompt.includes('Current editable file contents'));
  } finally {
    useSettings(defaultSettings());
  }
});

test('a fresh Codex repair conversation stays within the provider input limit after large edits', async t => {
  const { repo, editing } = await editedRepository(t);
  useSettings({ ...defaultSettings(), deferEditableContext: false });
  t.after(() => useSettings(defaultSettings()));
  const { prompt } = repairTurn(repo, editing, 'codex');
  assert.ok(prompt.length <= codexInputCharacters, `prompt is ${prompt.length} characters`);
  assert.ok(Buffer.byteLength(prompt) <= promptLimits.turnBytes, `prompt is ${Buffer.byteLength(prompt)} bytes`);
  const editable = JSON.parse(prompt.slice(prompt.lastIndexOf('\n[') + 1)) as { path: string; deferred?: true }[];
  assert.deepEqual(
    editable.map(file => file.path),
    files,
  );
  assert.ok(editable.some(file => !file.deferred) && editable.some(file => file.deferred));
  // Editable files are supplied once: neither the starting context nor its diffs repeat them.
  for (const path of files) assert.ok(occurrences(prompt, edited(path)) <= 1, path);
});

test('a fresh Claude repair conversation keeps changed files and diffs within the budget', async t => {
  const { repo, editing } = await editedRepository(t);
  const { prompt, coverage } = repairTurn(repo, editing, 'claude');
  assert.ok(Buffer.byteLength(prompt) <= promptLimits.turnBytes, `prompt is ${Buffer.byteLength(prompt)} bytes`);
  assert.ok(coverage!.selected.includes('AGENTS.md'));
  assert.ok(coverage!.omittedFiles > 0, 'some changed files are left to the repository tools');
});

test('required context that cannot fit is refused before dispatch, naming the remedy', async t => {
  const { repo, editing } = await editedRepository(t);
  assert.throws(() => repairTurn(repo, editing, 'claude', false), PromptBudgetError);
  assert.throws(() => repairTurn(repo, editing, 'codex', false), /turn prompt budget.*enable repository exploration/);
});

test('review context fills only what the request and evidence leave of the budget', async t => {
  const { repo, editing } = await editedRepository(t);
  const budget = new PromptBudget();
  budget.require(200 * 1024, 'Fixture request', 'none');
  const remaining = budget.remaining;
  const supplied = repositoryContext(repo, editing.snapshot, ['AGENTS.md'], true, { budget, diff: true });
  assert.ok(Buffer.byteLength(JSON.stringify(supplied)) <= remaining);
  assert.equal(supplied.changes!.total, files.length);
  assert.ok(supplied.diff!.length < files.length);
  // Without exploration every change is required, so the same review is refused rather than truncated.
  const strict = new PromptBudget();
  strict.require(200 * 1024, 'Fixture request', 'none');
  assert.throws(
    () => repositoryContext(repo, editing.snapshot, [], false, { budget: strict, diff: true }),
    PromptBudgetError,
  );
});

test('an assembled prompt over the budget is refused before any provider starts', () => {
  assert.doesNotThrow(() => requirePromptBudget('a'.repeat(promptLimits.turnBytes)));
  assert.throws(() => requirePromptBudget('a'.repeat(promptLimits.turnBytes + 1)), /nothing was sent to the provider/);
  // The budget counts UTF-8 bytes, which bound the characters Codex counts.
  assert.throws(() => requirePromptBudget('é'.repeat(promptLimits.turnBytes / 2 + 1)), PromptBudgetError);
});
