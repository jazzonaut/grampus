import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedRepository, pinnedContext, searchPinnedFiles } from '../src/repository-context.js';
import { repositoryContext } from '../src/repository-evidence.js';
import { snapshotRepository } from '../src/artifacts.js';
import { Store } from '../src/store.js';
import { Kickoffs } from '../src/kickoff.js';
import { normalizeGuidedPlan, guidedPlanDigest } from '../src/guided-plan.js';
import type { Connector } from '../src/agents/types.js';
import { startUi } from '../src/ui-server.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-context-')), repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'AGENTS.md'), 'Follow existing patterns.\n');
  writeFileSync(join(repo, 'main.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'helper.js'), 'export const value = 42;\n');
  writeFileSync(join(repo, 'asset.bin'), Buffer.alloc(1024 * 1024));
  mkdirSync(join(repo, 'many'));
  for (let index = 0; index < 220; index++) writeFileSync(join(repo, 'many', `file-${index}.js`), `// ${index}\n`);
  git('add', '.'); git('commit', '-m', 'Baseline'); const base = git('rev-parse', 'HEAD');
  const store = new Store(join(root, 'journal.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const plan = { brief: { title: 'Greeting', outcome: 'Print hello', criteria: ['Print hello'], plan: 'Verify greeting' },
    workspace: { repo, path: join(root, 'workspace'), base }, context: { files: ['main.js', 'helper.js'] },
    slices: [{ scope: { files: ['main.js'] }, validation: { file: 'node', args: ['--check', 'main.js'] },
      acceptance: { file: 'node', args: ['main.js'], expectedStdout: 'hello\n' }, message: 'Greeting' }] };
  return { root, repo, git, base, store, plan };
}

test('large repository metadata is cached; search is bounded and selected blobs remain pinned', t => {
  const f = fixture(t), tree = pinnedRepository(f.repo, f.base);
  assert.equal(pinnedRepository(f.repo, f.base), tree);
  const first = searchPinnedFiles(f.repo, f.base, 'many', 0), second = searchPinnedFiles(f.repo, f.base, 'many', 100);
  assert.equal(first.matches, 220); assert.equal(first.files.length, 100); assert.equal(first.nextOffset, 100);
  assert.equal(second.files.length, 100); assert.notEqual(first.files[0]!.path, second.files[0]!.path);
  writeFileSync(join(f.repo, 'main.js'), 'dirty checkout must not enter planning');
  const selected = pinnedContext(f.repo, f.base, ['main.js']);
  assert.deepEqual(selected.summary.selected, ['AGENTS.md', 'main.js']);
  assert.match(selected.files[1]!.content, /console.log/);
  assert.equal(selected.summary.omittedFiles, 222); assert.ok(selected.summary.totalBytes > 1024 * 1024);
  assert.throws(() => pinnedContext(f.repo, f.base, ['asset.bin']), /budget/);
  assert.throws(() => pinnedContext(f.repo, f.base, ['../outside']), /absent/);
  assert.throws(() => pinnedContext(f.repo, f.base, ['main.js', 'main.js']), /distinct/);
});

test('selected review context includes all changed files and verifies omitted-file bytes in the artifact', async t => {
  const f = fixture(t), before = await snapshotRepository(f.repo, f.base);
  writeFileSync(join(f.repo, 'helper.js'), 'export const value = 43;\n');
  const after = await snapshotRepository(f.repo, f.base), context = repositoryContext(f.repo, after, ['main.js']);
  assert.notEqual(before.artifact, after.artifact);
  assert.deepEqual(context.files.map(file => file.path), ['AGENTS.md', 'helper.js', 'main.js']);
  assert.ok(context.coverage.mandatory.includes('helper.js')); assert.equal(context.coverage.omittedFiles, 221);
  writeFileSync(join(f.repo, 'asset.bin'), Buffer.alloc(1024 * 1024, 255));
  assert.notEqual((await snapshotRepository(f.repo, f.base)).artifact, after.artifact);
  await assert.rejects(async () => repositoryContext(f.repo, await snapshotRepository(f.repo, f.base), ['main.js']), /Required context/);
  writeFileSync(join(f.repo, 'main.js'), 'a concurrent change');
  assert.throws(() => repositoryContext(f.repo, after, ['main.js']), /changed/);
});

test('snapshot batches original blobs while retaining exact text and binary before/after evidence', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'tiny.bin'), Buffer.from([0, 1, 255])); f.git('add', '.'); f.git('commit', '-m', 'Binary baseline');
  const base = f.git('rev-parse', 'HEAD');
  for (let index = 0; index < 220; index++) writeFileSync(join(f.repo, 'many', `file-${index}.js`), `// changed ${index}\n`);
  writeFileSync(join(f.repo, 'tiny.bin'), Buffer.from([0, 2, 255]));
  const snapshot = await snapshotRepository(f.repo, base);
  assert.equal(snapshot.diff.length, 221);
  const text = snapshot.diff.find(file => file.path === 'many/file-219.js')!;
  assert.equal(text.previousContent, '// 219\n'); assert.equal(text.content, '// changed 219\n');
  const binary = snapshot.diff.find(file => file.path === 'tiny.bin')!;
  assert.equal(binary.previousEncoding, 'base64'); assert.equal(binary.encoding, 'base64');
  assert.deepEqual(Buffer.from(binary.previousContent!, 'base64'), Buffer.from([0, 1, 255]));
  assert.deepEqual(Buffer.from(binary.content!, 'base64'), Buffer.from([0, 2, 255]));
});

test('approval binds selected supporting files and cannot authorize an uninspected action file', t => {
  const f = fixture(t), plan = normalizeGuidedPlan(f.plan);
  assert.ok(plan.context!.totalBytes > 256 * 1024);
  const other = normalizeGuidedPlan({ ...f.plan, context: { files: ['main.js'] } });
  assert.notEqual(guidedPlanDigest(plan), guidedPlanDigest(other));
  assert.throws(() => normalizeGuidedPlan({ ...f.plan, context: { files: ['helper.js'] } }), /Select main.js/);
  assert.throws(() => normalizeGuidedPlan({ ...f.plan, context: { ...plan.context, inventoryDigest: 'stale' } }), /inventory changed/);
  const twoSlices = normalizeGuidedPlan({ ...f.plan, brief: { ...f.plan.brief,
    slices: [{ title: 'Create', plan: 'Create helper', criteria: ['Print hello'] }, { title: 'Use', plan: 'Adapt created helper', criteria: ['Print hello'] }] },
    slices: [{ ...f.plan.slices[0], scope: { files: [], create: ['created.js'] } }, { ...f.plan.slices[0], scope: { files: ['created.js'] } }] });
  assert.equal(twoSlices.slices[1]!.scope.files[0], 'created.js');
  assert.ok(!twoSlices.context!.files.includes('created.js'), 'future contents are supplied from the later snapshot, not invented during approval');
});

test('context expansion invalidates a proposal and explicitly resupplies pinned files on the next turn', async t => {
  const f = fixture(t); let lastPrompt = '';
  const connector: Connector = async () => ({ turn: async prompt => {
    lastPrompt = prompt;
    return { status: 'completed', reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] }, usage: null, error: null };
  }, close: async () => {}, interrupt: async () => {} });
  const kickoffs = new Kickoffs(f.store, connector), id = kickoffs.create({ repo: f.repo, request: 'Change main greeting', contextFiles: ['main.js'] });
  const ready = await kickoffs.send(id); assert.ok(ready.candidate); assert.doesNotMatch(lastPrompt, /export const value/);
  const expanded = kickoffs.changeContext(id, ['main.js', 'helper.js'], ready.turnKey);
  assert.equal(expanded.candidate, null); assert.notEqual(expanded.turnKey, ready.turnKey);
  assert.throws(() => kickoffs.prepare(id, ready.candidateDigest!), /questions\/errors/);
  assert.throws(() => kickoffs.changeContext(id, ['main.js'], ready.turnKey), /changed/);
  const replanned = await kickoffs.send(id, 'Consider the helper too');
  assert.ok(replanned.candidate); assert.match(lastPrompt, /export const value = 42/); assert.match(lastPrompt, /omitted/);
  assert.ok(replanned.candidate!.context!.files.includes('helper.js'));
  kickoffs.prepare(id, replanned.candidateDigest!);
  assert.throws(() => kickoffs.changeContext(id, ['main.js'], replanned.turnKey), /settled/);

  // Another controller can convert the proposal while selected blobs are read.
  const raceId = kickoffs.create({ repo: f.repo, request: 'Greeting', contextFiles: ['main.js'] });
  const raceReady = await kickoffs.send(raceId), originalTransaction = f.store.transaction.bind(f.store);
  let transactions = 0;
  f.store.transaction = <T>(action: () => T): T => {
    if (++transactions === 2) f.store.appendSession(raceId, 'kickoff.converted', { taskId: 'offline-concurrent-conversion' });
    return originalTransaction(action);
  };
  try { assert.throws(() => kickoffs.changeContext(raceId, ['main.js', 'helper.js'], raceReady.turnKey), /state changed/); }
  finally { f.store.transaction = originalTransaction; }

  // A settled provider response must not revalidate its old context after expansion.
  const expandedFiles = pinnedContext(f.repo, f.base, ['main.js', 'helper.js']);
  let injectContext = false;
  const racedPlanner = new Kickoffs(f.store, async (...args) => {
    const agent = await connector(...args);
    return { ...agent, turn: async prompt => { const result = await agent.turn(prompt); injectContext = true; return result; } };
  });
  const responseId = racedPlanner.create({ repo: f.repo, request: 'Greeting', contextFiles: ['main.js'] });
  f.store.transaction = <T>(action: () => T): T => {
    if (injectContext && f.store.session<{ phase: string }>(responseId).phase === 'idle'
      && f.store.sessionEvents(responseId).some(event => event.type === 'kickoff.message' && (event.data as { role?: string }).role === 'assistant')) {
      injectContext = false; f.store.appendSession(responseId, 'kickoff.context_changed', { files: expandedFiles.files, context: expandedFiles.summary });
    }
    return originalTransaction(action);
  };
  try {
    const raced = await racedPlanner.send(responseId);
    assert.equal(raced.candidate, null); assert.match(raced.error!, /newer planning request or context/);
    assert.ok(raced.config.files.includes('helper.js'));
  } finally { f.store.transaction = originalTransaction; }
});

test('dashboard inspection is paginated and polling never serializes a 100k-file snapshot', async t => {
  const f = fixture(t), ui = await startUi({ db: f.store.path, port: 0 });
  try {
    const url = new URL(ui.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
    const post = async (path: string, value: unknown) => {
      const response = await fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(value) });
      assert.ok(response.ok, await response.clone().text()); return response.json() as Promise<any>;
    };
    const inspected = await post('/api/repositories/inspect', { repo: f.repo, request: 'main greeting', contextFiles: ['main.js'] });
    assert.equal(inspected.context.totalFiles, 224); assert.equal(inspected.context.omittedFiles, 222);
    const page = await post('/api/repositories/files', { repo: f.repo, base: inspected.base, query: 'many' });
    assert.equal(page.files.length, 100); assert.equal(page.matches, 220);
    const created = await post('/api/tasks', { plan: f.plan }), task = f.store.get<any>(created.id);
    // A read-only fixture inventory, never used as execution evidence.
    task.guided.snapshot = { artifact: 'sha256:fixture', instructionsDigest: 'fixture', head: f.base, index: 'large inventory',
      files: Array.from({ length: 100000 }, (_, index) => ({ path: `file-${index}.js`, sha256: '0'.repeat(64), executable: false })), instructions: [], diff: [] };
    f.store.save(created.id, task);
    const get = async (path: string) => { const response = await fetch(url.origin + path, { headers }); assert.ok(response.ok); return response.text(); };
    const body = await get(`/api/tasks/${created.id}`), value = JSON.parse(body);
    assert.ok(Buffer.byteLength(body) < 24000); assert.equal(value.state.snapshot.totalFiles, 100000);
    assert.deepEqual(value.state.snapshot.files, []); assert.equal(value.state.snapshot.index, ''); assert.equal(value.report, null);
    assert.equal(await get(`/api/tasks/${created.id}`), body);
    const list = await get('/api/state'); assert.ok(Buffer.byteLength(list) < 4000);
    task.guided.note = 'Updated by another connection'; f.store.save(created.id, task);
    assert.match(await get(`/api/tasks/${created.id}`), /Updated by another connection/);
  } finally { await ui.close(); }
});
