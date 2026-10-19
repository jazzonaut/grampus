import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/persistence/store.js';
import { Workflow, type Agent, type Evidence } from '../src/domain/workflow.js';
import { renderReport } from '../src/reporting/report.js';

const brief = {
  title: 'Greeting',
  outcome: 'Print a greeting',
  criteria: ['Output is hello world', 'Output ends with a newline'],
  plan: 'Implement, simplify, validate, review, verify',
};
const implementer: Agent = { provider: 'codex', model: 'test-model', sessionId: 'implementation-session' };
const reviewer: Agent = { provider: 'claude', model: 'test-review-model', sessionId: 'review-session' };

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-test-'));
  const path = join(root, 'grampus.sqlite');
  const store = new Store(path);
  const workflow = new Workflow(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const task = workflow.create(brief);
  return { root, path, store, workflow, task };
}

function implemented(workflow: Workflow, id: string) {
  workflow.approve(id, workflow.get(id).version);
  const attempt = workflow.start(id, implementer);
  workflow.finish(id, attempt.id, attempt.version, 'succeeded', 'sha256:fixture', 'Implementation finished');
  return attempt;
}

function evidence(workflow: Workflow, id: string, kind: Evidence['kind'], changes: Partial<Evidence> = {}): Evidence {
  const task = workflow.get(id);
  return {
    id: randomUUID(),
    attemptId: task.attempt!.id,
    version: task.version,
    artifact: task.attempt!.artifact!,
    kind,
    ...(kind === 'quality' ? { pass: 'simplification' } : {}),
    outcome: 'passed',
    source: kind === 'review' ? 'agent' : 'controller',
    summary: `Observed ${kind}`,
    criteria: task.brief.criteria,
    ...(kind === 'review' ? { agent: reviewer } : {}),
    ...changes,
  };
}

function allEvidence(workflow: Workflow, id: string): void {
  for (const kind of ['quality', 'validation', 'review', 'verification'] as const)
    workflow.record(id, evidence(workflow, id, kind));
}

test('an approved implementation requires every evidence gate and criterion before completion', t => {
  const { workflow, task, store } = fixture(t);
  assert.throws(() => workflow.start(task.id, implementer), /approval/);
  implemented(workflow, task.id);
  assert.throws(() => workflow.complete(task.id), /validation has not passed/);
  allEvidence(workflow, task.id);
  workflow.complete(task.id);
  assert.equal(workflow.get(task.id).phase, 'complete');
  assert.equal(store.events(task.id).at(-1)?.type, 'task.completed');
  assert.throws(() => workflow.start(task.id, implementer), /current state/);
});

test('revising the brief invalidates approval and evidence; late results remain visible', t => {
  const { workflow, task, store } = fixture(t);
  const old = implemented(workflow, task.id);
  allEvidence(workflow, task.id);
  workflow.revise(task.id, 1, { ...brief, criteria: ['Output is goodbye'] });
  assert.throws(() => workflow.approve(task.id, 1), /outdated/);
  assert.throws(() => workflow.start(task.id, implementer), /approval/);
  workflow.approve(task.id, 2);
  const current = workflow.start(task.id, implementer);
  assert.equal(workflow.finish(task.id, old.id, 1, 'succeeded', 'old', 'Late result'), false);
  assert.equal(workflow.get(task.id).attempt?.id, current.id);
  assert.equal(workflow.get(task.id).evidence.length, 0);
  assert.equal(store.events(task.id).at(-1)?.type, 'result.ignored');
});

test('revisions must wait for running work to settle', t => {
  const { workflow, task } = fixture(t);
  workflow.approve(task.id, 1);
  workflow.start(task.id, implementer);
  assert.throws(() => workflow.revise(task.id, 1, brief), /Settle/);
  workflow.requestStop(task.id);
  assert.throws(() => workflow.revise(task.id, 1, brief), /Settle/);
  assert.equal(workflow.get(task.id).version, 1);
});

test('stop requested is not stopped and a racing success cannot override it', t => {
  const { workflow, task } = fixture(t);
  workflow.approve(task.id, 1);
  const attempt = workflow.start(task.id, implementer);
  workflow.requestStop(task.id);
  assert.equal(workflow.get(task.id).phase, 'stop_requested');
  assert.equal(workflow.finish(task.id, attempt.id, 1, 'succeeded', 'x', 'Racing success'), false);
  assert.throws(() => workflow.start(task.id, implementer), /current state/);
  assert.throws(() => workflow.confirmStopped(task.id, 'wrong-attempt', 'exit observed'), /matching/);
  workflow.confirmStopped(task.id, attempt.id, 'Owned child process exit observed');
  assert.equal(workflow.get(task.id).phase, 'stopped');
  assert.throws(() => workflow.complete(task.id), /not finished/);
});

test('retry within the same requirements version rejects old attempt evidence', t => {
  const { workflow, task } = fixture(t);
  implemented(workflow, task.id);
  const stale = evidence(workflow, task.id, 'review');
  const next = workflow.start(task.id, { ...implementer, sessionId: 'retry-session' });
  workflow.finish(task.id, next.id, 1, 'succeeded', 'sha256:new', 'Retry completed');
  assert.equal(workflow.record(task.id, stale), false);
  assert.equal(workflow.get(task.id).evidence.length, 0);
});

test('artifact mismatch, duplicate results, and duplicate evidence cannot replace current evidence', t => {
  const { workflow, task } = fixture(t);
  const attempt = implemented(workflow, task.id);
  assert.equal(workflow.finish(task.id, attempt.id, 1, 'succeeded', 'changed', 'Duplicate'), false);
  assert.equal(workflow.record(task.id, evidence(workflow, task.id, 'validation', { artifact: 'wrong' })), false);
  const check = evidence(workflow, task.id, 'validation');
  assert.equal(workflow.record(task.id, check), true);
  assert.equal(workflow.record(task.id, { ...check, outcome: 'failed' }), false);
  assert.equal(workflow.get(task.id).evidence.length, 1);
});

test('failed and skipped checks block completion and remain in history after retry', t => {
  const { workflow, task, store } = fixture(t);
  implemented(workflow, task.id);
  allEvidence(workflow, task.id);
  for (const outcome of ['failed', 'skipped'] as const) {
    workflow.record(task.id, evidence(workflow, task.id, 'validation', { outcome }));
    assert.throws(() => workflow.complete(task.id), /validation has not passed/);
  }
  workflow.record(task.id, evidence(workflow, task.id, 'validation'));
  workflow.complete(task.id);
  const report = renderReport(store, task.id);
  assert.match(report, /"outcome": "failed"/);
  assert.match(report, /"outcome": "skipped"/);
  assert.match(report, /Usage and billed cost: unknown/);
});

test('a provider claim or synthetic test cannot establish real validation', t => {
  const { workflow, task } = fixture(t);
  implemented(workflow, task.id);
  assert.throws(
    () => workflow.record(task.id, evidence(workflow, task.id, 'validation', { source: 'agent' })),
    /claims alone/,
  );
  assert.throws(
    () => workflow.record(task.id, evidence(workflow, task.id, 'verification', { source: 'synthetic' })),
    /Synthetic evidence/,
  );
});

test('an implementer cannot approve their own review session', t => {
  const { workflow, task } = fixture(t);
  implemented(workflow, task.id);
  assert.throws(
    () => workflow.record(task.id, evidence(workflow, task.id, 'review', { agent: implementer })),
    /independent/,
  );
  assert.equal(workflow.record(task.id, evidence(workflow, task.id, 'review')), true);
});

test('verification must address every approved criterion', t => {
  const { workflow, task } = fixture(t);
  implemented(workflow, task.id);
  allEvidence(workflow, task.id);
  workflow.record(task.id, evidence(workflow, task.id, 'verification', { criteria: [brief.criteria[0]!] }));
  assert.throws(() => workflow.complete(task.id), /all acceptance criteria/);
});

test('same-provider independent review needs an explicit fallback reason', t => {
  const { workflow, task, store } = fixture(t);
  implemented(workflow, task.id);
  const fallback = evidence(workflow, task.id, 'review', { agent: { ...implementer, sessionId: 'fresh-review' } });
  assert.throws(() => workflow.record(task.id, fallback), /fallback reason/);
  workflow.record(task.id, { ...fallback, fallbackReason: 'Other provider unavailable' });
  assert.ok(store.events(task.id).some(event => event.type === 'review.same_provider_fallback'));
});

test('a decision proposed during implementation remains visible when implementation finishes', t => {
  const { workflow, task } = fixture(t);
  workflow.approve(task.id, 1);
  const attempt = workflow.start(task.id, implementer);
  workflow.addDecision(task.id, 'Provisional behavior change');
  workflow.finish(task.id, attempt.id, 1, 'succeeded', 'sha256:fixture', 'Done');
  assert.equal(workflow.get(task.id).phase, 'awaiting_decision');
});

test('pending provisional decisions survive revisions and block completion', t => {
  const { workflow, task } = fixture(t);
  implemented(workflow, task.id);
  const decision = workflow.addDecision(task.id, 'Change a public interface');
  workflow.revise(task.id, 1, brief);
  implemented(workflow, task.id);
  allEvidence(workflow, task.id);
  assert.throws(() => workflow.complete(task.id), /decisions need acceptance/);
  assert.throws(() => workflow.acceptDecision(task.id, decision, 1), /Version conflict/);
  workflow.acceptDecision(task.id, decision, 2);
  workflow.complete(task.id);
});

test('journal and state survive an actual child controller exit without closing the database', t => {
  const { path, store, workflow } = fixture(t);
  const script = `
    import { Store } from ${JSON.stringify(new URL('../src/persistence/store.js', import.meta.url).href)};
    import { Workflow } from ${JSON.stringify(new URL('../src/domain/workflow.js', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    const workflow = new Workflow(store);
    const task = workflow.create(${JSON.stringify(brief)});
    workflow.approve(task.id, 1);
    const attempt = workflow.start(task.id, ${JSON.stringify(implementer)});
    process.stdout.write(JSON.stringify({ taskId: task.id, attemptId: attempt.id }), () => process.exit(17));
  `;
  let output = '';
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script, path], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = (error as { stdout: string }).stdout;
  }
  const result = JSON.parse(output) as { taskId: string; attemptId: string };
  assert.equal(workflow.get(result.taskId).phase, 'running');
  assert.equal(store.events(result.taskId).length, 3);
  assert.deepEqual(workflow.recover(), [result.taskId]);
  assert.deepEqual(workflow.recover(), []);
  assert.equal(workflow.get(result.taskId).phase, 'recovery_required');
  assert.throws(() => workflow.start(result.taskId, implementer), /current state/);
  assert.equal(
    workflow.finish(result.taskId, result.attemptId, 1, 'succeeded', 'old', 'Untrusted late completion'),
    false,
  );
  workflow.confirmStopped(result.taskId, result.attemptId, 'Test process exited with code 17; no worker spawned');
  assert.notEqual(workflow.start(result.taskId, implementer).id, result.attemptId);
});

test('invalid state changes roll back their journal entries and state', t => {
  const { workflow, task, store } = fixture(t);
  const before = store.events(task.id);
  assert.throws(() => workflow.approve(task.id, 42), /outdated/);
  assert.deepEqual(store.events(task.id), before);
  assert.equal(workflow.get(task.id).phase, 'draft');
  assert.throws(
    () =>
      store.transaction(() => {
        store.append(task.id, 1, 'should.rollback', {});
        throw new Error('Simulated write failure');
      }),
    /Simulated/,
  );
  assert.deepEqual(store.events(task.id), before);
});

test('two controller connections cannot approve a stale brief version', t => {
  const { workflow, task, path } = fixture(t);
  const otherStore = new Store(path);
  try {
    const other = new Workflow(otherStore);
    const viewedVersion = other.get(task.id).version;
    workflow.revise(task.id, 1, { ...brief, outcome: 'Changed outcome' });
    assert.throws(() => other.approve(task.id, viewedVersion), /outdated/);
    assert.equal(other.get(task.id).approvedVersion, null);
  } finally {
    otherStore.close();
  }
});

test('malformed or empty acceptance criteria cannot create tasks', t => {
  const { workflow } = fixture(t);
  assert.throws(() => workflow.create({ ...brief, criteria: [] }), /criteria required/);
  assert.throws(() => workflow.create({ ...brief, criteria: [' '] }), /empty/);
  assert.throws(() => workflow.create({ ...brief, criteria: ['same', 'same'] }), /distinct/);
});

test('report keeps provider prose inside its data block', t => {
  const { workflow, store } = fixture(t);
  const task = workflow.create({ ...brief, title: '<script>bad()</script>\n# Forged heading' });
  const report = renderReport(store, task.id);
  assert.ok(report.startsWith('# &#60;script&#62;'));
  assert.ok(!report.includes('\n# Forged heading'));
});
