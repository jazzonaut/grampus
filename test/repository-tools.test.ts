import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryTools } from '../src/repository/repository-tools.js';
import { snapshotRepository } from '../src/repository/artifacts.js';
import { authorizeEditTool } from '../src/execution/edit-policy.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { Store } from '../src/persistence/store.js';
import type { AgentEvent, Connector } from '../src/providers/types.js';
import { claudeRepositoryTools, isRepositoryTool } from '../src/providers/claude-repository.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-explore-')),
    repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@invalid');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'caller.js'), 'import { value } from "./dependency.js";\nconsole.log(value);\n');
  writeFileSync(join(repo, 'src', 'dependency.js'), 'export const value = "hidden-contract-4829";\n');
  writeFileSync(join(repo, 'asset.bin'), Buffer.from([0, 255]));
  mkdirSync(join(repo, 'many'));
  for (let i = 0; i < 150; i++) writeFileSync(join(repo, 'many', `${String(i).padStart(3, '0')}.txt`), `line ${i}\n`);
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const base = git('rev-parse', 'HEAD');
  const cleanup: (() => void)[] = [];
  t.after(() => {
    for (const close of cleanup) close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, git, base, cleanup };
}

test('repository tools discover dependencies outside initial context and read pinned content, with pagination', t => {
  const f = fixture(t),
    events: AgentEvent[] = [];
  const invoke = repositoryTools(
    { repo: f.repo, base: f.base },
    event => events.push(event),
    () => true,
  );
  writeFileSync(join(f.repo, 'src', 'dependency.js'), 'dirty checkout');
  const first = invoke('grampus_list_files', {}) as any;
  assert.equal(first.files.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal((invoke('grampus_list_files', { offset: 100 }) as any).nextOffset, null);
  const search = invoke('grampus_search', { query: 'hidden-contract', path: 'src/' }) as any;
  assert.equal(search.matches[0].path, 'src/dependency.js');
  const read = invoke('grampus_read_file', { path: search.matches[0].path, limit: 1 }) as any;
  assert.match(read.lines[0], /hidden-contract-4829/);
  assert.equal(read.nextOffset, 1);
  assert.equal((invoke('grampus_read_file', { path: 'src/dependency.js', offset: 1 }) as any).nextOffset, null);
  assert.equal(read.source, f.base);
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    events.some(
      event => event.type === 'repository.tool_result' && JSON.stringify(event.data).includes('hidden-contract-4829'),
    ),
  );
  const page = invoke('grampus_search', { query: 'line 149', path: 'many/' }) as any;
  assert.equal(page.matches.length, 0);
  assert.equal(page.nextOffset, 128);
  assert.equal(
    (invoke('grampus_search', { query: 'line 149', path: 'many/', offset: page.nextOffset }) as any).matches[0].path,
    'many/149.txt',
  );
});

test('repository tools enforce input, output, ownership and durable journaling without exposing arbitrary paths', t => {
  const f = fixture(t);
  let active = true;
  const invoke = repositoryTools(
    { repo: f.repo, base: f.base },
    () => {},
    () => active,
  );
  for (const path of ['../outside', '/etc/passwd', '.git/config', 'src/../src/dependency.js'])
    assert.throws(() => invoke('grampus_read_file', { path }), /inventory/);
  assert.throws(() => invoke('grampus_read_file', { path: 'asset.bin' }), /binary/);
  assert.throws(() => invoke('grampus_read_file', { path: 'src/caller.js', limit: 0 }), /positive/);
  assert.throws(() => invoke('grampus_list_files', { offset: -1 }), /offset/);
  assert.throws(() => invoke('grampus_list_files', { command: 'whoami' }), /argument/);
  assert.throws(() => invoke('shell', {}), /Invalid/);
  active = false;
  assert.throws(() => invoke('grampus_read_file', { path: 'src/caller.js' }), /active owned turn/);
  const failedJournal = repositoryTools(
    { repo: f.repo, base: f.base },
    () => {
      throw new Error('Journal unavailable');
    },
    () => true,
  );
  assert.throws(() => failedJournal('grampus_read_file', { path: 'src/dependency.js' }), /Journal unavailable/);
});

test('Git ignore rules exclude untracked outputs while tracked files remain discoverable and verified', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\ndist/\n*.lock\n');
  writeFileSync(join(f.repo, 'dependencies.lock'), 'tracked dependency data\n');
  f.git('add', '.gitignore');
  f.git('add', '-f', 'dependencies.lock');
  f.git('commit', '-m', 'Ignore outputs, retain tracked lockfile');
  const base = f.git('rev-parse', 'HEAD');
  for (const directory of ['node_modules', 'dist']) {
    mkdirSync(join(f.repo, directory));
    writeFileSync(join(f.repo, directory, 'oversized.bin'), Buffer.alloc(1024 * 1024));
  }
  writeFileSync(join(f.repo, 'untracked.lock'), 'ignored\n');
  const snapshot = await snapshotRepository(f.repo, base);
  assert.ok(snapshot.files.some(file => file.path === 'dependencies.lock'));
  assert.equal(
    snapshot.files.some(file => /^(node_modules|dist)\//.test(file.path) || file.path === 'untracked.lock'),
    false,
  );
  for (const access of [
    { repo: f.repo, base },
    { repo: f.repo, snapshot },
  ]) {
    const invoke = repositoryTools(
      access,
      () => {},
      () => true,
    );
    assert.match(JSON.stringify(invoke('grampus_read_file', { path: 'dependencies.lock' })), /tracked dependency data/);
    assert.throws(() => invoke('grampus_read_file', { path: 'node_modules/oversized.bin' }), /inventory/);
    assert.throws(() => invoke('grampus_read_file', { path: 'dist/oversized.bin' }), /inventory/);
  }
  writeFileSync(join(f.repo, 'dist', 'oversized.bin'), 'different ignored output');
  assert.equal((await snapshotRepository(f.repo, base)).artifact, snapshot.artifact);
  writeFileSync(join(f.repo, 'dependencies.lock'), 'changed tracked lockfile');
  assert.notEqual((await snapshotRepository(f.repo, base)).artifact, snapshot.artifact);
});

test('execution reads bind supporting files to the snapshot while approved edits remain readable without expanding write scope', async t => {
  const f = fixture(t),
    snapshot = await snapshotRepository(f.repo, f.base);
  const invoke = repositoryTools(
    { repo: f.repo, snapshot, editable: ['src/caller.js', 'created.js'] },
    () => {},
    () => true,
  );
  assert.match(JSON.stringify(invoke('grampus_read_file', { path: 'src/dependency.js' })), /hidden-contract/);
  const context = {
    cwd: f.repo,
    snapshot,
    policy: { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, files: ['src/caller.js'] },
  };
  assert.equal(
    authorizeEditTool(context, 'Write', { file_path: 'src/dependency.js', content: 'unauthorized' }, () => {}).allowed,
    false,
  );
  writeFileSync(join(f.repo, 'src', 'caller.js'), 'approved changed bytes');
  assert.match(JSON.stringify(invoke('grampus_read_file', { path: 'src/caller.js' })), /approved changed/);
  writeFileSync(join(f.repo, 'created.js'), 'new approved content');
  assert.match(JSON.stringify(invoke('grampus_read_file', { path: 'created.js' })), /new approved/);
  writeFileSync(join(f.repo, 'src', 'dependency.js'), 'unapproved mutation');
  assert.throws(() => invoke('grampus_read_file', { path: 'src/dependency.js' }), /changed since/);
  const review = repositoryTools(
    { repo: f.repo, snapshot },
    () => {},
    () => true,
  );
  assert.throws(() => review('grampus_read_file', { path: 'src/caller.js' }), /changed since/);
});

test('workspace exploration rejects symlink replacements', async t => {
  const f = fixture(t),
    snapshot = await snapshotRepository(f.repo, f.base);
  const invoke = repositoryTools(
    { repo: f.repo, snapshot },
    () => {},
    () => true,
  );
  rmSync(join(f.repo, 'src'), { recursive: true });
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'dependency.js'), 'outside bytes');
  symlinkSync(outside, join(f.repo, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => invoke('grampus_read_file', { path: 'src/dependency.js' }), /links/);
});

test('large search files have explicit omissions and remain available through paginated direct reads', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src', 'large.js'), '// searchable\n'.repeat(400000));
  f.git('add', '.');
  f.git('commit', '-m', 'Large searchable text');
  const base = f.git('rev-parse', 'HEAD'),
    snapshot = await snapshotRepository(f.repo, base);
  for (const access of [
    { repo: f.repo, base },
    { repo: f.repo, snapshot },
  ]) {
    const invoke = repositoryTools(
      access,
      () => {},
      () => true,
    );
    const search = invoke('grampus_search', { query: 'searchable', path: 'src/large.js' }) as any;
    assert.equal(search.matches.length, 0);
    assert.equal(search.skipped[0].reason, 'Large file; read directly');
    const read = invoke('grampus_read_file', { path: 'src/large.js', limit: 1 }) as any;
    assert.deepEqual(read.lines, ['// searchable']);
    assert.equal(read.nextOffset, 1);
  }
});

test('character pages read complete large single-line text with bounded output through both provider tools', async t => {
  const f = fixture(t),
    text = '"\\😀'.repeat(70000);
  writeFileSync(join(f.repo, 'src', 'single-line.json'), text);
  f.git('add', '.');
  f.git('commit', '-m', 'Large single line');
  const base = f.git('rev-parse', 'HEAD'),
    snapshot = await snapshotRepository(f.repo, base);
  for (const access of [
    { repo: f.repo, base },
    { repo: f.repo, snapshot },
  ]) {
    const invoke = repositoryTools(
      access,
      () => {},
      () => true,
    );
    assert.throws(() => invoke('grampus_read_file', { path: 'src/single-line.json' }), /mode=characters/);
    let offset: number | null = 0,
      observed = '';
    while (offset !== null) {
      const page = invoke('grampus_read_file', { path: 'src/single-line.json', mode: 'characters', offset }) as any;
      assert.ok(Buffer.byteLength(JSON.stringify(page.content)) <= 24000);
      assert.equal(page.bytes, Buffer.byteLength(text));
      assert.equal(page.mode, 'characters');
      observed += page.content;
      offset = page.nextOffset;
    }
    assert.equal(observed, text);
    assert.throws(() => invoke('grampus_read_file', { path: 'src/single-line.json', mode: 'other' }), /mode/);
    assert.throws(() => invoke('grampus_read_file', { path: 'src/single-line.json', limit: 401 }), /limit/);
  }
  const handler = claudeRepositoryTools(
    { repo: f.repo, snapshot },
    () => {},
    () => true,
  ).find(tool => tool.name === 'grampus_read_file')!;
  const result = await handler.handler(
    { path: 'src/single-line.json', mode: 'characters', offset: 0, limit: 12000, root: undefined },
    undefined,
  );
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse((result.content[0] as { text: string }).text).mode, 'characters');
});

test('Claude repository handlers recheck ownership and journaling even without SDK permission hooks', t => {
  const f = fixture(t);
  let active = true;
  const tools = claudeRepositoryTools(
    { repo: f.repo, base: f.base },
    () => {},
    () => active,
  );
  const read = tools.find(tool => tool.name === 'grampus_read_file')!;
  return (async () => {
    const result = await read.handler(
      { path: 'src/dependency.js', mode: undefined, offset: undefined, limit: undefined, root: undefined },
      undefined,
    );
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /hidden-contract/);
    active = false;
    assert.equal(
      (
        await read.handler(
          { path: 'src/dependency.js', mode: undefined, offset: undefined, limit: undefined, root: undefined },
          undefined,
        )
      ).isError,
      true,
    );
    assert.equal(isRepositoryTool('mcp__grampus_repository__grampus_read_file'), true);
    assert.equal(isRepositoryTool('mcp__foreign__grampus_read_file'), false);
    const failed = claudeRepositoryTools(
      { repo: f.repo, base: f.base },
      () => {
        throw new Error('Journal unavailable');
      },
      () => true,
    );
    assert.equal(
      (await failed[0]!.handler({ query: undefined, offset: undefined, root: undefined }, undefined)).isError,
      true,
    );
  })();
});

test('Claude exposes snapshot change pagination and fences its results by ownership and journaling', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/dependency.js'), '\u0001'.repeat(24000));
  const snapshot = await snapshotRepository(f.repo, f.base);
  let active = true;
  const events: AgentEvent[] = [];
  const changes = claudeRepositoryTools(
    { repo: f.repo, snapshot },
    event => events.push(event),
    () => active,
  ).find(tool => tool.name === 'grampus_read_changes')!;
  const input = { path: 'src/dependency.js', side: 'before' as const, offset: 0, limit: 12000 };
  const result = await changes.handler(input, undefined);
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.content), /hidden-contract-4829/);
  assert.ok(events.some(event => event.type === 'repository.tool_result'));
  const invoke = repositoryTools(
    { repo: f.repo, snapshot },
    () => {},
    () => true,
  );
  let offset: number | null = 0,
    content = '';
  while (offset !== null) {
    const page = invoke('grampus_read_changes', { path: 'src/dependency.js', offset }) as any;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
    content += page.content;
    offset = page.nextOffset;
  }
  assert.equal(content, '\u0001'.repeat(24000));
  active = false;
  assert.equal((await changes.handler(input, undefined)).isError, true);
  const failed = claudeRepositoryTools(
    { repo: f.repo, snapshot },
    () => {
      throw new Error('Journal unavailable');
    },
    () => true,
  ).find(tool => tool.name === 'grampus_read_changes')!;
  assert.equal((await failed.handler(input, undefined)).isError, true);
  assert.equal(isRepositoryTool('mcp__grampus_repository__grampus_read_changes'), true);
});

test('kickoff starts without file selection, discovers its own edit scope and records exploration', async t => {
  const f = fixture(t),
    store = new Store(join(f.root, 'journal.sqlite'));
  f.cleanup.push(() => store.close());
  const connector: Connector = async (_provider, options) => ({
    turn: async prompt => {
      assert.ok(options.repository);
      assert.match(prompt, /Do not ask the user to locate code/);
      const invoke = repositoryTools(options.repository, options.emit, () => true);
      const found = invoke('grampus_list_files', { query: 'dependency' }) as any;
      invoke('grampus_read_file', { path: found.files[0] });
      return {
        status: 'completed',
        usage: null,
        error: null,
        reply: {
          kind: 'message',
          questions: [],
          findings: [],
          text: JSON.stringify({
            brief: {
              title: 'Adapt contract',
              outcome: 'Update value',
              criteria: ['Print updated value'],
              plan: 'Update dependency and check caller',
            },
            slices: [
              {
                scope: { files: [found.files[0]] },
                validation: { file: 'node', args: ['--check', found.files[0]] },
                acceptance: { file: 'node', args: ['src/caller.js'], expectedStdout: 'updated\n' },
                message: 'Update contract',
              },
            ],
          }),
        },
      };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const kickoffs = new Kickoffs(store, connector),
    id = kickoffs.create({ repo: f.repo, request: 'Update the contract' });
  assert.deepEqual(kickoffs.view(id).config.files, []);
  const result = await kickoffs.send(id);
  assert.equal(result.error, null);
  assert.equal(result.candidate!.context!.exploration, true);
  assert.deepEqual(result.candidate!.context!.files, []);
  assert.deepEqual(result.candidate!.slices[0]!.scope.files, ['src/dependency.js']);
  assert.ok(store.sessionEvents(id).some(event => event.type === 'repository.tool_result'));
});
