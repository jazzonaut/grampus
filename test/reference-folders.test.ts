import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReference, normalizeReferences, suggestReferenceFolders } from '../src/repository/reference-folders.js';
import { repositoryTools } from '../src/repository/repository-tools.js';
import { normalizeGuidedPlan } from '../src/domain/guided-plan.js';
import { allowMcpTool, isExternalMcpTool, projectMcpServers } from '../src/providers/integrations.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-references-')),
    repo = join(root, 'repo'),
    reference = join(root, 'reference');
  mkdirSync(repo);
  mkdirSync(reference);
  mkdirSync(join(reference, 'subfolder'));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  for (const directory of [repo, reference]) {
    git(directory, 'init');
    git(directory, 'config', 'user.name', 'Fixture');
    git(directory, 'config', 'user.email', 'fixture@invalid');
    git(directory, 'config', 'core.autocrlf', 'false');
  }
  writeFileSync(join(repo, 'main.js'), 'main project\n');
  writeFileSync(join(reference, 'outside.js'), 'outside selected subtree\n');
  writeFileSync(join(reference, 'subfolder', 'pdf.js'), 'svg-to-pdfkit then pdfkit\n');
  for (const directory of [repo, reference]) {
    git(directory, 'add', '.');
    git(directory, 'commit', '-m', 'Baseline');
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, reference, git, base: git(repo, 'rev-parse', 'HEAD') };
}

test('reference roots expose only a selected Git subtree and keep committed content pinned', t => {
  const f = fixture(t),
    ref = inspectReference(join(f.reference, 'subfolder'));
  const invoke = repositoryTools(
    { repo: f.repo, base: f.base, references: [ref] },
    () => {},
    () => true,
  );
  writeFileSync(join(f.reference, 'subfolder', 'pdf.js'), 'dirty reference');
  assert.deepEqual((invoke('grampus_list_files', { root: 'reference-1' }) as any).files, ['pdf.js']);
  assert.match(JSON.stringify(invoke('grampus_read_file', { root: 'reference-1', path: 'pdf.js' })), /svg-to-pdfkit/);
  assert.throws(() => invoke('grampus_read_file', { root: 'reference-1', path: '../outside.js' }), /inventory/);
  assert.throws(() => invoke('grampus_read_file', { root: 'reference-2', path: 'pdf.js' }), /Unknown reference/);
  assert.throws(() => invoke('Write', { root: 'reference-1', path: 'pdf.js' }), /Invalid repository tool/);
  assert.throws(
    () =>
      normalizeGuidedPlan({
        brief: { title: 'PDF', outcome: 'PDF', criteria: ['PDF'], plan: 'Adapt PDF' },
        workspace: { repo: f.repo, path: join(f.root, 'workspace') },
        references: [ref],
        slices: [
          {
            scope: { files: [join(f.reference, 'subfolder', 'pdf.js')] },
            validation: { file: 'node', args: [] },
            acceptance: { file: 'node', args: [], expectedStdout: '' },
            message: 'PDF',
          },
        ],
      }),
    /relative|file policy|Edit policy/,
  );
});

test('plain reference folders bind content hashes and reject changes between turns', t => {
  const f = fixture(t),
    folder = join(f.root, 'plain folder');
  mkdirSync(folder);
  writeFileSync(join(folder, 'spec.md'), 'Reference contract');
  const ref = inspectReference(folder);
  const invoke = repositoryTools(
    { repo: f.repo, base: f.base, references: [ref] },
    () => {},
    () => true,
  );
  assert.match(
    JSON.stringify(invoke('grampus_read_file', { root: 'reference-1', path: 'spec.md' })),
    /Reference contract/,
  );
  writeFileSync(join(folder, 'spec.md'), 'Changed contract');
  assert.throws(() => invoke('grampus_read_file', { root: 'reference-1', path: 'spec.md' }), /changed/);
  assert.throws(
    () =>
      repositoryTools(
        { repo: f.repo, base: f.base, references: [ref] },
        () => {},
        () => true,
      ),
    /changed/,
  );
  assert.throws(() => normalizeReferences([ref]), /changed/);
});

test('folders untracked by an enclosing repository or one without commits are plain references', t => {
  const f = fixture(t),
    untracked = join(f.reference, 'untracked'),
    empty = join(f.root, 'empty-repo'),
    nested = join(empty, 'notes');
  mkdirSync(untracked);
  writeFileSync(join(untracked, 'spec.md'), 'Untracked contract');
  mkdirSync(nested, { recursive: true });
  f.git(empty, 'init');
  writeFileSync(join(nested, 'spec.md'), 'Uncommitted contract');
  for (const folder of [untracked, nested]) {
    const ref = inspectReference(folder);
    assert.equal(ref.repo, null);
    assert.equal(ref.totalFiles, 1);
    const invoke = repositoryTools(
      { repo: f.repo, base: f.base, references: [ref] },
      () => {},
      () => true,
    );
    assert.match(JSON.stringify(invoke('grampus_read_file', { root: 'reference-1', path: 'spec.md' })), /contract/);
  }
  assert.throws(() => inspectReference(nested, 'HEAD'));
});

test('folder suggestions identify mentioned paths and agent suggestions never grant access', t => {
  const f = fixture(t),
    path = join(f.reference, 'subfolder');
  assert.equal(
    suggestReferenceFolders(`Use this for reference: ${path}\nImprove the PDF flow.`)[0]!.path,
    realpathSync.native(path),
  );
  const events: unknown[] = [],
    invoke = repositoryTools(
      { repo: f.repo, base: f.base },
      event => events.push(event),
      () => true,
    );
  invoke('grampus_suggest_reference_folder', { path, reason: 'Contains the existing PDF implementation' });
  assert.deepEqual(
    events.map(event => (event as { type: string }).type),
    ['repository.tool_requested', 'reference.suggested', 'repository.tool_result'],
  );
  assert.throws(() => invoke('grampus_read_file', { root: 'reference-1', path: 'pdf.js' }), /Unknown reference/);
  assert.throws(() => normalizeReferences([path, path]), /distinct/);
});

test('configured MCP tool authorization permits integrations and discovery without granting built-in file or shell tools', () => {
  const events: unknown[] = [];
  assert.equal(isExternalMcpTool('mcp__linear__get_issue'), true);
  assert.equal(isExternalMcpTool('mcp__grampus_repository__grampus_read_file'), false);
  assert.equal(
    allowMcpTool('mcp__linear__get_issue', event => events.push(event), true),
    true,
  );
  assert.equal(
    allowMcpTool('ToolSearch', event => events.push(event), true),
    true,
  );
  assert.equal(
    allowMcpTool('mcp__linear__get_issue', () => {}, false),
    false,
  );
  for (const name of ['Bash', 'Write', 'Edit', 'mcp__grampus_files__delete_file'])
    assert.equal(
      allowMcpTool(name, () => {}, true),
      false,
    );
  assert.throws(
    () =>
      allowMcpTool(
        'mcp__linear__get_issue',
        () => {
          throw new Error('Journal failed');
        },
        true,
      ),
    /Journal failed/,
  );
});

test('source-project MCP configuration survives a worktree while respecting configured disabled servers', t => {
  const f = fixture(t);
  writeFileSync(
    join(f.repo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        reference_docs: { type: 'http', url: 'https://example.invalid/docs' },
        disabled_docs: { type: 'http', url: 'https://example.invalid/disabled' },
      },
    }),
  );
  assert.deepEqual(projectMcpServers(f.repo, f.reference), {});
  mkdirSync(join(f.repo, '.claude'));
  writeFileSync(
    join(f.repo, '.claude', 'settings.local.json'),
    JSON.stringify({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['disabled_docs'] }),
  );
  assert.deepEqual(projectMcpServers(f.repo, f.reference), {
    reference_docs: { type: 'http', url: 'https://example.invalid/docs' },
  });
  assert.deepEqual(projectMcpServers(f.repo, f.repo), {}, 'the provider loads its own project configuration in place');
});
