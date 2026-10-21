// Directory grants are checked through native authorisation and final real Git snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  authorizeEditTool,
  prepareEditing,
  verifyEditingScope,
  type EditingContext,
} from '../src/execution/edit-policy.js';
import { snapshotRepository } from '../src/repository/artifacts.js';

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

test('approved directory actions allow new nested helpers while refusing controls, siblings and unapproved suffixes', async t => {
  const context = fixture(t, { 'root.txt': 'baseline' });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', context.cwd, ...args], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@invalid');
  mkdirSync(join(context.cwd, 'src'));
  writeFileSync(join(context.cwd, 'src', 'existing.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-m', 'Baseline');
  context.snapshot = await snapshotRepository(context.cwd, git('rev-parse', 'HEAD'));
  context.policy = {
    artifact: context.snapshot.artifact,
    instructionsDigest: context.snapshot.instructionsDigest,
    files: [],
    directories: [{ path: 'src', actions: ['edit', 'create'], suffixes: ['.ts'] }],
  };
  prepareEditing(context);
  const write = (path: string) =>
    authorizeEditTool(context, 'Write', { file_path: path, content: 'export const added = true;' }, () => {}).allowed;
  assert.equal(write('src/nested/helper.ts'), true);
  assert.equal(write('src/AGENTS.md'), false);
  assert.equal(write('src/.git/config.ts'), false);
  assert.equal(write('src-neighbour/helper.ts'), false);
  assert.equal(write('src/helper.js'), false);
  mkdirSync(join(context.cwd, 'src', 'nested'));
  writeFileSync(join(context.cwd, 'src', 'nested', 'helper.ts'), 'export const added = true;');
  writeFileSync(join(context.cwd, 'src', 'existing.ts'), 'export const value = 2;\n');
  verifyEditingScope(context, await snapshotRepository(context.cwd, context.snapshot.head));
  writeFileSync(join(context.cwd, 'root.txt'), 'outside grant');
  assert.throws(
    () =>
      verifyEditingScope(context, {
        ...context.snapshot,
        files: [
          ...context.snapshot.files.filter(file => file.path !== 'root.txt'),
          { path: 'root.txt', sha256: 'changed', executable: false },
        ],
      }),
    /outside the explicit/,
  );
});
