import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeEditTool,
  authorizeFileChanges,
  editingFileContext,
  editingScopeFiles,
  prepareEditing,
  verifyEditingScope,
  type EditingContext,
} from '../src/execution/edit-policy.js';
import { execFileSync } from 'node:child_process';
import { promptLimits } from '../src/config/limits.js';
import { PromptBudget } from '../src/providers/prompt-budget.js';

function fixture(t: { after(fn: () => void): void }, contents: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'grampus-text-policy-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const artifact = `sha256:${'a'.repeat(64)}`,
    instructionsDigest = 'b'.repeat(64);
  for (const [path, text] of Object.entries(contents)) writeFileSync(join(cwd, path), text);
  const context: EditingContext = {
    cwd,
    policy: { artifact, instructionsDigest, files: Object.keys(contents) },
    snapshot: {
      artifact,
      instructionsDigest,
      head: 'fixture',
      index: '',
      instructions: [],
      diff: [],
      files: Object.entries(contents).map(([path, text]) => ({
        path,
        sha256: createHash('sha256').update(text).digest('hex'),
        executable: false,
      })),
    },
  };
  return context;
}

test('bounded large text supports both provider edit paths without a filename exception', t => {
  const context = fixture(t, { 'dependency-data.yaml': 'entry: value\n'.repeat(32000) });
  prepareEditing(context);
  assert.equal(
    authorizeEditTool(
      context,
      'Edit',
      { file_path: 'dependency-data.yaml', old_string: 'entry: value', new_string: 'entry: updated' },
      () => {},
    ).allowed,
    true,
  );
  assert.equal(
    authorizeFileChanges(
      context,
      [{ path: 'dependency-data.yaml', kind: { type: 'update' }, diff: '-entry: value\n+entry: updated' }],
      () => {},
    ),
    true,
  );
  assert.equal(
    authorizeEditTool(
      context,
      'Write',
      { file_path: 'dependency-data.yaml', content: 'a'.repeat(256 * 1024 + 1) },
      () => {},
    ).allowed,
    false,
  );
});

test('exploration defers large editable contents with explicit metadata and keeps the initial prompt bounded', t => {
  const context = fixture(t, {
    'first.txt': 'first\n'.repeat(90000),
    'second.txt': 'second\n'.repeat(90000),
    'small.txt': 'small\n',
  });
  prepareEditing(context);
  const encoded = editingFileContext(context, true),
    files = JSON.parse(encoded);
  assert.ok(Buffer.byteLength(encoded) <= promptLimits.turnBytes);
  for (const path of ['first.txt', 'second.txt']) {
    const file = files.find((file: { path: string }) => file.path === path);
    assert.equal(file.deferred, true);
    assert.equal(file.content, null);
    assert.match(file.readWith, /grampus_read_file/);
    assert.equal(file.sha256, context.snapshot.files.find(file => file.path === path)!.sha256);
  }
  assert.equal(files.find((file: { path: string }) => file.path === 'small.txt').content, 'small\n');
  assert.throws(() => editingFileContext(context), /256 KiB turn prompt budget.*enable repository exploration/);
  // Whatever the earlier parts of the prompt used, deferring keeps every remaining entry within budget.
  const budget = new PromptBudget();
  budget.require(budget.remaining - 2048, 'Fixture request', 'none');
  const deferred = JSON.parse(editingFileContext(context, true, budget)) as { deferred?: true }[];
  assert.equal(deferred.filter(file => file.deferred).length, 2);
  assert.ok(budget.remaining >= 0);
});

test('unsupported text reports the exact path, observed size, limit and useful next action', t => {
  const context = fixture(t, { 'too-large.txt': 'a'.repeat(1024 * 1024 + 1) });
  assert.throws(() => prepareEditing(context), /too-large\.txt.*1048577.*1 MiB.*[Rr]evise/);
});

test('authorization exposes complete large text and refuses content changed since its snapshot', t => {
  const text = 'entry: value\n'.repeat(32000),
    context = fixture(t, { 'data.yaml': text });
  assert.deepEqual(editingScopeFiles(context), [{ path: 'data.yaml', content: text }]);
  writeFileSync(join(context.cwd, 'data.yaml'), 'external edit');
  assert.throws(() => editingScopeFiles(context), /changed.*data\.yaml/);
});

test('per-file and total scope bounds stay enforced independently of prompt pagination', t => {
  const text = 'a'.repeat(1024 * 1024),
    context = fixture(t, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.txt`, text])));
  assert.throws(() => prepareEditing(context), /4 MiB.*smaller slices/);
  context.policy.files = context.policy.files.slice(0, 4);
  prepareEditing(context);
  assert.ok(Buffer.byteLength(editingFileContext(context, true)) < 768 * 1024);
});

test(
  'a creation matches the final snapshot without regard to case on Windows, like every other policy path',
  { skip: process.platform !== 'win32' },
  t => {
    const context = fixture(t, { 'existing.txt': 'kept\n' });
    execFileSync('git', ['init', '-q', context.cwd], { windowsHide: true, stdio: 'pipe' });
    context.policy.create = ['Notes.txt'];
    // The agent wrote the authorised creation with different letter case; Windows treats it as the same file.
    writeFileSync(join(context.cwd, 'notes.txt'), 'created\n');
    const after = {
      ...context.snapshot,
      files: [
        ...context.snapshot.files,
        { path: 'notes.txt', sha256: createHash('sha256').update('created\n').digest('hex'), executable: false },
      ],
    };
    assert.doesNotThrow(() => verifyEditingScope(context, after));
  },
);
