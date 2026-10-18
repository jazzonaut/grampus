import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startUi } from '../src/ui-server.js';
import { Kickoffs } from '../src/kickoff.js';
import { Store } from '../src/store.js';
import { GuidedTasks } from '../src/guided-tasks.js';
import type { Connector, Reply } from '../src/agents/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-')), repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('config', 'user.name', 'Offline test'); git('config', 'user.email', 'offline@example.invalid'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n"); git('add', '.'); git('commit', '-m', 'Baseline');
  const plan = { brief: { title: 'Verify greeting', outcome: 'Confirm hello with a newline', criteria: ['Greeting prints hello followed by a newline'], plan: 'Check existing behavior and independently review without changes' },
    workspace: { repo, path: join(root, 'workspace') }, slices: [{ mode: 'no_change', scope: { files: [] },
      validation: { file: 'node', args: ['--check', 'greeting.js'] }, acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello\n' }, message: 'Confirm greeting' }] };
  return { root, repo, plan, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function expected(view: any) {
  const s = view.state;
  return JSON.stringify({ version: s.version, digest: s.digest, status: s.status, stage: s.stage, artifact: s.snapshot?.artifact ?? null,
    instructionsDigest: s.snapshot?.instructionsDigest ?? null, executionId: s.executionId, reviewId: s.reviewId, questionKey: view.questionKey ?? null });
}
test('dashboard requires its local token and origin, rejects stale decisions, and preserves drafts over restart', async t => {
  const f = fixture(t), db = join(f.root, 'journal.sqlite');
  let ui = await startUi({ db, port: 0 });
  t.after(async () => { await ui.close(); f.cleanup(); });
  let url = new URL(ui.url), base = url.origin, token = url.hash.slice(1);
  const req = (path: string, payload?: unknown) => fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' } })).status, 403);
  const rebound = await new Promise<number>(resolve => {
    const req = request(base + '/api/state', { headers: { Authorization: `Bearer ${token}`, Host: 'rebound.example' } }, response => { response.resume(); resolve(response.statusCode!); }); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await req('/api/tasks', { plan: f.plan })).status, 201);
  const list = await (await req('/api/state')).json() as any, id = list.tasks[0].id;
  const view = await (await req(`/api/tasks/${id}`)).json() as any;
  assert.equal(view.state.status, 'draft'); assert.equal(view.state.plan.workspace.base, f.git('rev-parse', 'HEAD'));
  assert.equal((await req(`/api/tasks/${id}/approve`, { version: 1, digest: view.state.digest, expected: 'stale' })).status, 400);
  assert.equal(ui.store.workspaces().length, 0);
  assert.equal((await req(`/api/tasks/${id}/approve`, { version: 1, digest: view.state.digest, expected: expected(view) })).status, 200);
  await assert.rejects(new GuidedTasks(ui.store, { expectedState: expected(view) }).run(id), /changed/);
  assert.equal(ui.store.workspaces().length, 0);
  assert.equal((await req(`/api/tasks/${id}/approve`, { version: 1, digest: view.state.digest, expected: expected(view) })).status, 400);
  await ui.close(); ui = await startUi({ db, port: 0 }); url = new URL(ui.url); base = url.origin; token = url.hash.slice(1);
  const reopened = await (await req(`/api/tasks/${id}`)).json() as any;
  assert.equal(reopened.state.status, 'ready'); assert.equal(reopened.task.approvedVersion, 1);
  assert.equal(reopened.report, null);
  assert.match((await (await req(`/api/tasks/${id}/report`)).json() as any).report, /Verify greeting/);
  const connector: Connector = async () => ({ turn: async () => ({ status: 'completed', reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] }, usage: null, error: null }), close: async () => {}, interrupt: async () => {} });
  const planners = new Kickoffs(ui.store, connector);
  const kickoff = await (await req('/api/kickoffs', { repo: f.repo, request: 'Confirm greeting' })).json() as any;
  const planned = await planners.send(kickoff.id);
  const prepare = `/api/kickoffs/${kickoff.id}/prepare`;
  assert.equal((await req(prepare, { digest: 'stale' })).status, 400);
  assert.equal((await req(prepare, { digest: planned.candidateDigest })).status, 201);
  assert.equal((await req(prepare, { digest: planned.candidateDigest })).status, 400);
  assert.equal(ui.store.workspaces().length, 0);
});

test('dashboard workers use real file/check checkpoints without bypassing assessment or replaying clicks', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), ui = await startUi({ db: join(f.root, 'journal.sqlite'), port: 0 });
  t.after(async () => { await ui.close(); f.cleanup(); });
  const url = new URL(ui.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const get = async (path: string) => (await fetch(url.origin + path, { headers })).json() as Promise<any>;
  const post = (path: string, payload: unknown) => fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(payload) });
  const created = await (await post('/api/tasks', { plan: f.plan })).json() as any, id = created.id;
  const route = `/api/tasks/${id}`;
  const wait = async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const state = await get('/api/state');
      if (!state.jobs[id]?.running) { assert.equal(state.jobs[id]?.error ?? null, null); return get(route); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  };
  let view = await get(route);
  await post(route + '/approve', { version: 1, digest: view.state.digest, expected: expected(view) });
  view = await get(route);
  assert.equal((await post(route + '/run', { expected: expected(view) })).status, 202);
  assert.equal((await post(route + '/run', { expected: expected(view) })).status, 400);
  view = await wait(); assert.equal(view.state.status, 'awaiting_scope', view.state.note);
  assert.equal(view.scopeFiles[0].content, "console.log('hello');\n");
  assert.equal((await post(route + '/authorize', { expected: expected(view) })).status, 202);
  view = await wait(); assert.equal(view.state.status, 'awaiting_assessment', view.state.note);
  assert.equal(view.checks[0].phase, 'passed'); assert.equal(view.deliveries.length, 0);
  await post(route + '/assess', { expected: expected(view), outcome: 'failed', summary: 'Offline UI test deliberately refuses the simplification gate.' });
  view = await wait(); assert.equal(view.state.status, 'blocked'); assert.equal(view.deliveries.length, 0);
  assert.equal(view.state.reviewId, null); assert.equal(f.git('rev-parse', 'HEAD'), view.state.plan.workspace.base);
});

test('kickoff clarifies consequential ambiguity, validates generated commands and creates only an unapproved draft', async t => {
  const f = fixture(t), store = new Store(join(f.root, 'journal.sqlite')); t.after(() => { store.close(); f.cleanup(); });
  const replies: Reply[] = [{ kind: 'question', text: 'Which greeting should be preserved?', questions: [{ id: 'greeting', prompt: 'Which exact greeting?', choices: ['hello', 'hello world'] }], findings: [] },
    { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] },
    { kind: 'message', text: 'This is not a validated plan.', questions: [], findings: [] },
    { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] }];
  let seen = '';
  const connector: Connector = async (_, options) => ({ turn: async prompt => {
    seen += prompt;
    options.emit({ type: 'session.connected', data: { providerSessionId: 'offline-planner', model: 'offline-fixture' } });
    return { status: 'completed', reply: replies.shift()!, usage: null, error: null };
  }, close: async () => {}, interrupt: async () => {} });
  const kickoffs = new Kickoffs(store, connector), id = kickoffs.create({ repo: f.repo, request: 'Verify the greeting', provider: 'claude' });
  assert.equal(store.list().length, 0); assert.equal(store.workspaces().length, 0);
  const question = await kickoffs.send(id); assert.equal(question.session.phase, 'awaiting_answer');
  assert.match(seen, /console.log\('hello'\)/); assert.match(seen, /Pinned repository/);
  assert.throws(() => kickoffs.prepare(id), /questions/);
  const answered = await kickoffs.send(id, undefined, { greeting: 'hello' });
  assert.equal(answered.error, null); assert.equal(answered.candidate!.implementation.provider, 'claude');
  assert.equal(answered.candidate!.review.provider, 'codex'); assert.equal(answered.candidate!.workspace.base, f.git('rev-parse', 'HEAD'));
  assert.equal(answered.candidate!.implementation.timeoutMs, 300000);
  assert.throws(() => kickoffs.prepare(id, 'outdated-proposal'), /changed/);
  assert.match(seen, /User answers/);
  const invalid = await kickoffs.send(id, 'Revise the checks'); assert.ok(invalid.error);
  assert.equal(invalid.candidate, null);
  assert.throws(() => kickoffs.prepare(id), /errors/);
  await kickoffs.send(id, 'Return the complete corrected plan');
  const taskId = kickoffs.prepare(id), task = store.get<any>(taskId);
  assert.equal(task.guided.status, 'draft'); assert.equal(task.approvedVersion, null); assert.equal(store.workspaces().length, 0);
  assert.equal(kickoffs.view(id).taskId, taskId);
  assert.throws(() => kickoffs.prepare(id), /already/);
  await assert.rejects(kickoffs.send(id, 'Change it after conversion'), /already/);
});

test('kickoff omits binary assets and rejects their explicit selection before inference', t => {
  const f = fixture(t), store = new Store(join(f.root, 'journal.sqlite')); t.after(() => { store.close(); f.cleanup(); });
  writeFileSync(join(f.repo, 'binary.bin'), Buffer.from([0, 1, 2])); f.git('add', '.'); f.git('commit', '-m', 'Binary fixture');
  const kickoffs = new Kickoffs(store);
  assert.throws(() => kickoffs.create({ repo: f.repo, request: 'Change something', contextFiles: ['binary.bin'] }), /UTF-8/);
  assert.equal(store.sessions().length, 0);
  const id = kickoffs.create({ repo: f.repo, request: 'Change greeting' });
  assert.deepEqual(kickoffs.view(id).config.files, ['greeting.js']);
  assert.equal(kickoffs.view(id).config.context!.omittedFiles, 1);
});

test('generated inline checks with broken newline escaping are rejected before a task or command can run', async t => {
  const f = fixture(t), store = new Store(join(f.root, 'journal.sqlite')); t.after(() => { store.close(); f.cleanup(); });
  f.plan.slices[0]!.validation.args = ['-e', "require('node:assert/strict').equal('hello\n', 'hello\n')"];
  const connector: Connector = async () => ({ turn: async () => ({ status: 'completed', reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] }, usage: null, error: null }), close: async () => {}, interrupt: async () => {} });
  const kickoffs = new Kickoffs(store, connector), id = kickoffs.create({ repo: f.repo, request: 'Verify the greeting' });
  const view = await kickoffs.send(id);
  assert.match(view.error!, /invalid JavaScript/); assert.equal(view.candidate, null);
  assert.throws(() => kickoffs.prepare(id), /errors/); assert.equal(store.list().length, 0); assert.equal(store.workspaces().length, 0);
});

test('a revision request invalidates an older proposal even if its worker exits before turn claim', async t => {
  const f = fixture(t), store = new Store(join(f.root, 'journal.sqlite')); t.after(() => { store.close(); f.cleanup(); });
  const connector: Connector = async () => ({ turn: async () => ({ status: 'completed', reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] }, usage: null, error: null }), close: async () => {}, interrupt: async () => {} });
  const kickoffs = new Kickoffs(store, connector), id = kickoffs.create({ repo: f.repo, request: 'Verify greeting', timeoutMs: 600000 });
  const ready = await kickoffs.send(id); assert.ok(ready.candidate);
  assert.equal(ready.candidate.implementation.timeoutMs, 600000); assert.equal(ready.candidate.review.timeoutMs, 600000);
  // Durable boundary reached by send() before runSession can claim a provider turn.
  store.appendSession(id, 'kickoff.message', { role: 'user', text: 'Change the acceptance examples' });
  store.appendSession(id, 'kickoff.error', { error: null });
  assert.equal(kickoffs.view(id).candidate, null);
  assert.throws(() => kickoffs.prepare(id, ready.candidateDigest!), /questions\/errors/); assert.equal(store.list().length, 0);
});

test('an explicit continuation after first-turn connection failure resupplies pinned files and the planning protocol', async t => {
  const f = fixture(t), store = new Store(join(f.root, 'journal.sqlite')); t.after(() => { store.close(); f.cleanup(); });
  let connections = 0, supplied = '';
  const connector: Connector = async () => {
    if (++connections === 1) throw new Error('Offline first-connection failure');
    return { turn: async prompt => { supplied = prompt; return { status: 'completed', reply: { kind: 'message', text: JSON.stringify(f.plan), questions: [], findings: [] }, usage: null, error: null }; }, close: async () => {}, interrupt: async () => {} };
  };
  const kickoffs = new Kickoffs(store, connector), id = kickoffs.create({ repo: f.repo, request: 'Verify greeting' });
  const failed = await kickoffs.send(id); assert.match(failed.error!, /first-connection failure/);
  assert.equal(connections, 1); assert.equal(failed.candidate, null);
  const continued = await kickoffs.send(id, 'Try planning again with the original requirements');
  assert.equal(connections, 2); assert.equal(continued.error, null); assert.ok(continued.candidate);
  assert.match(supplied, /Pinned repository/); assert.match(supplied, /console.log\('hello'\)/); assert.match(supplied, /JSON guided plan/); assert.match(supplied, /Try planning again/);
});

test('a reopened dashboard observes the original live worker, refuses takeover and can stop its real check', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), db = join(f.root, 'journal.sqlite');
  f.plan.slices[0]!.validation.args = ['-e', 'setInterval(() => {}, 1000)'];
  let ui = await startUi({ db, port: 0 });
  t.after(async () => { await ui.close(); f.cleanup(); });
  let url = new URL(ui.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const get = async (path: string) => (await fetch(url.origin + path, { headers })).json() as Promise<any>;
  const post = (path: string, payload: unknown) => fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(payload) });
  const created = await (await post('/api/tasks', { plan: f.plan })).json() as any, route = `/api/tasks/${created.id}`;
  const until = async (predicate: (view: any) => boolean) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { const view = await get(route); if (predicate(view)) return view; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Expected persisted checkpoint was not reached');
  };
  let view = await get(route); await post(route + '/approve', { version: 1, digest: view.state.digest, expected: expected(view) });
  view = await get(route); await post(route + '/run', { expected: expected(view) });
  view = await until(view => view.state.status === 'awaiting_scope');
  // Let the preparation worker exit before authorizing through the same server.
  while ((await get('/api/state')).jobs[created.id]?.running) await new Promise(resolve => setTimeout(resolve, 50));
  await post(route + '/authorize', { expected: expected(view) });
  view = await until(view => view.checks[0]?.phase === 'running' && view.checks[0]?.toolPid);
  const owner = view.state.owner, checkId = view.checks[0].id;
  assert.notEqual(owner.controllerPid, process.pid);
  await assert.rejects(ui.close(), /still running/);
  // Close only the HTTP/store surface. The actual controller runs in a separate process.
  await new Promise<void>(resolve => ui.server.close(() => resolve())); ui.store.close();
  ui = await startUi({ db, port: 0 }); url = new URL(ui.url); headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  view = await get(route); assert.deepEqual(view.state.owner, owner); assert.equal(view.checks.length, 1);
  assert.equal((await post(route + '/recover', { expected: expected(view) })).status, 202);
  const deadline = Date.now() + 15000;
  let job: any;
  do { job = (await get('/api/state')).jobs[created.id]; if (!job?.running) break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  assert.match(job.error, /still alive/);
  assert.equal((await post(route + '/stop', {})).status, 200);
  view = await until(view => view.state.owner === null);
  assert.equal(view.state.status, 'blocked'); assert.equal(view.checks.length, 1); assert.equal(view.checks[0].id, checkId);
  assert.equal(view.checks[0].phase, 'interrupted'); assert.equal(view.deliveries.length, 0);
});

test('planner answers bind the displayed turn even when later questions reuse the same id', async t => {
  const f = fixture(t), store = new Store(join(f.root, 'journal.sqlite')); t.after(() => { store.close(); f.cleanup(); });
  let turns = 0;
  const connector: Connector = async () => ({ turn: async () => ({ status: 'completed', reply: { kind: 'question', text: 'Clarify the example', questions: [{ id: 'example', prompt: ++turns === 1 ? 'Which greeting?' : 'Should that greeting also apply to the edge case?', choices: [] }], findings: [] }, usage: null, error: null }), close: async () => {}, interrupt: async () => {} });
  const planners = new Kickoffs(store, connector), id = planners.create({ repo: f.repo, request: 'Update greeting' });
  const first = await planners.send(id);
  const second = await planners.send(id, undefined, { example: 'hello' }, undefined, first.turnKey);
  assert.notEqual(first.turnKey, second.turnKey); assert.equal(turns, 2);
  const count = store.sessionEvents(id).length;
  await assert.rejects(planners.send(id, undefined, { example: 'stale answer' }, undefined, first.turnKey), /changed/);
  assert.equal(turns, 2); assert.equal(store.sessionEvents(id).length, count);
});
