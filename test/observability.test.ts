// Exercises observed relationships and replay over a real SQLite journal, without spending provider turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../src/execution/sessions.js';
import { fixture } from './helpers/guided-tasks.js';
import { observabilityView } from '../src/server/view-model/observability.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { normalizeGuidedPlan } from '../src/domain/guided-plan.js';

test('observability correlates sessions, separates models and tools, and redacts previews', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const session = new Sessions(f.store).create('codex', f.repo);
  f.store.transaction(() => {
    f.store.append(task.id, task.version, 'guided.kickoff_linked', { sessionId: session.id });
    f.store.appendSession(session.id, 'turn.requested', {
      runId: 'run-1',
      stage: 'planning',
      prompt: 'password=hidden',
    });
    f.store.appendSession(session.id, 'session.connected', { runId: 'run-1', data: { model: 'observed-model' } });
    f.store.appendSession(session.id, 'activity.started', {
      runId: 'run-1',
      data: {
        id: 'call-1',
        kind: 'tool',
        name: 'read_file',
        providerTurnId: 'provider-turn',
      },
    });
    f.store.appendSession(session.id, 'activity.completed', {
      runId: 'run-1',
      data: {
        id: 'call-1',
        kind: 'tool',
        name: 'read_file',
        status: 'completed',
        durationMs: 12,
      },
    });
    f.store.appendSession(session.id, 'turn.result', {
      runId: 'run-1',
      result: { status: 'completed' },
      exitConfirmed: true,
    });
  });
  const revision = f.store.revision();
  const view = observabilityView(f.store, { kind: 'task', id: task.id });
  assert.equal(f.store.revision(), revision, 'observation must never write workflow state or evidence');
  assert.ok(view.nodes.some(node => node.kind === 'model'));
  assert.ok(view.events.some(event => event.label === 'Connected to observed-model'));
  assert.ok(
    view.events.some(event => event.source === `agent:${session.id}` && event.target === `tools:${session.id}`),
  );
  const call = view.events.find(event => event.type === 'activity.completed');
  assert.equal(call?.correlation.runId, 'run-1');
  assert.equal(call?.correlation.itemId, 'call-1');
  assert.equal(call?.durationMs, 12);
  assert.doesNotMatch(JSON.stringify(view), /hidden/);
  assert.equal(view.events.find(event => event.type === 'turn.result')?.updates[0]?.status, 'completed');
  assert.ok(view.events.every(event => event.id && event.cursor));
});

test('history pages have deterministic cursors and never invent a tool completion', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const session = new Sessions(f.store).create('claude', f.repo);
  f.store.transaction(() => {
    f.store.append(task.id, task.version, 'guided.kickoff_linked', { sessionId: session.id });
    f.store.appendSession(session.id, 'tool.authorized', { runId: 'r', data: { tool: 'Read' } });
  });
  const latest = observabilityView(f.store, { kind: 'task', id: task.id }, null, 2);
  assert.equal(latest.events.length, 2);
  assert.ok(latest.before);
  const older = observabilityView(f.store, { kind: 'task', id: task.id }, latest.before, 2);
  assert.ok(older.events.every(event => !latest.events.some(recent => recent.id === event.id)));
  assert.equal(latest.events.find(event => event.type === 'tool.authorized')?.status, 'observed');
  assert.equal(latest.events.find(event => event.type === 'tool.authorized')?.source, 'controller');
  assert.equal(latest.events.find(event => event.type === 'tool.authorized')?.target, `agent:${session.id}`);
  assert.equal(
    latest.nodes.some(node => node.kind === 'tools' && node.recorded !== false),
    false,
  );
  assert.match(latest.coverage.join(' '), /authorisation.*completion/i);
});

test('unconfirmed provider and check exits remain unknown even when an operation reports completion', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.plan);
  const session = new Sessions(f.store).create('claude', f.repo);
  f.store.transaction(() => {
    f.store.append(task.id, task.version, 'guided.kickoff_linked', { sessionId: session.id });
    f.store.appendSession(session.id, 'turn.result', {
      runId: 'uncertain',
      result: { status: 'completed' },
      exitConfirmed: false,
    });
    f.store.append(task.id, task.version, 'check.settled', {
      checkId: 'check',
      phase: 'recovery_required',
      result: { exitConfirmed: false },
    });
  });
  const view = observabilityView(f.store, { kind: 'task', id: task.id });
  assert.equal(view.events.find(event => event.type === 'turn.result')?.status, 'unknown');
  assert.equal(view.events.find(event => event.type === 'turn.result')?.category, 'failure');
  assert.equal(view.events.find(event => event.type === 'check.settled')?.status, 'unknown');
});

test('planning history pages preserve identities and conversion includes each planner once', t => {
  const f = fixture(t);
  const kickoffs = new Kickoffs(f.store);
  const id = kickoffs.create({ repo: f.repo, request: 'Plan a greeting' });
  const subject = { kind: 'planning', id } as const;
  f.store.transaction(() => {
    f.store.appendSession(id, 'turn.requested', { runId: 'plan', prompt: 'private prompt' });
    f.store.appendSession(id, 'activity.started', {
      runId: 'plan',
      data: { id: 'read', kind: 'tool', name: 'read_file' },
    });
    f.store.appendSession(id, 'turn.result', { runId: 'plan', result: { status: 'completed' }, exitConfirmed: false });
    f.store.appendSession(id, 'kickoff.candidate', { plan: normalizeGuidedPlan(f.plan) });
  });
  const revision = f.store.revision();
  const view = observabilityView(f.store, subject);
  assert.equal(f.store.revision(), revision);
  assert.deepEqual(view.subject, subject);
  assert.ok(view.events.every(event => event.correlation.taskId === null && event.correlation.sessionId === id));
  assert.equal(view.events.find(event => event.type === 'turn.result')?.status, 'unknown');
  assert.equal(view.nodes.find(node => node.kind === 'tools')?.recorded, true);
  assert.equal(view.events.find(event => event.type === 'kickoff.candidate')?.source, 'controller');
  assert.doesNotMatch(JSON.stringify(view), /private prompt|"files"/);
  const ids: string[] = [];
  let before: string | null = null;
  do {
    const page = observabilityView(f.store, subject, before, 2);
    ids.unshift(...page.events.map(event => event.id));
    before = page.before;
  } while (before);
  assert.deepEqual(
    ids,
    view.events.map(event => event.id),
  );
  assert.equal(new Set(ids).size, ids.length);

  const taskId = kickoffs.prepare(id);
  const task = f.store.get(taskId);
  f.store.append(taskId, task.version, 'guided.kickoff_linked', { sessionId: id });
  const linked = observabilityView(f.store, { kind: 'task', id: taskId });
  assert.equal(linked.nodes.filter(node => node.id === `agent:${id}`).length, 1);
  assert.equal(linked.nodes.filter(node => node.id === `tools:${id}`).length, 1);
  for (const event of view.events) {
    const matches = linked.events.filter(item => item.id === event.id);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.correlation.taskId, taskId);
  }
  assert.equal(new Set(linked.events.map(event => event.id)).size, linked.events.length);
  const converted = observabilityView(f.store, subject);
  assert.ok(converted.events.every(event => event.correlation.sessionId === id));
  assert.ok(converted.events.some(event => event.type === 'kickoff.converted'));
  assert.equal(converted.nodes.filter(node => node.kind === 'agent').length, 1);
});
