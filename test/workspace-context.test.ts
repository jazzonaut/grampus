// Conversation rotation preserves the execution, durable spending and settled ownership checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareWorkspaceContinuation } from '../src/execution/workspace-context.js';
import { sessionContinuation } from '../src/execution/session-context.js';
import { agentToolsetVersion } from '../src/providers/types.js';
import { fixture, windows } from './helpers/guided-tasks.js';

test(
  'native progress rotates provider context at the approved limit without resetting its execution',
  windows,
  async t => {
    const f = fixture(t);
    const task = f.tasks.create({ ...f.plan, workflowPolicy: { mode: 'supervised', maxSessionTurns: 2 } });
    f.tasks.approve(task.id, 1, task.guided!.digest);
    const state = await f.tasks.run(task.id);
    const execution = f.store.execution(state.executionId!);
    const session = f.store.session(execution.sessionId);
    session.providerSessionId = 'first-conversation';
    session.toolsetVersion = agentToolsetVersion;
    f.store.transaction(() => {
      f.store.saveSession(session.id, session);
      for (const runId of ['first', 'second']) {
        f.store.appendSession(session.id, 'turn.requested', { runId });
        f.store.appendSession(session.id, 'turn.result', { runId, result: { status: 'completed' } });
      }
    });
    prepareWorkspaceContinuation(f.store, execution.id);
    assert.equal(f.store.session(session.id).providerSessionId, null);
    assert.equal(f.store.execution(execution.id).sessionId, session.id);
    assert.equal(f.store.sessionEvents(session.id, ['turn.requested']).length, 2);
    assert.equal(f.store.sessionEvents(session.id, ['session.context_reset']).length, 1);
    assert.equal(f.store.events(task.id).filter(event => event.type === 'agent.context_reset').length, 1);

    const rotated = f.store.session(session.id);
    rotated.providerSessionId = 'second-conversation';
    f.store.transaction(() => {
      f.store.saveSession(session.id, rotated);
      f.store.appendSession(session.id, 'turn.requested', { runId: 'third' });
      f.store.appendSession(session.id, 'turn.result', { runId: 'third', result: { status: 'completed' } });
    });
    const decision = sessionContinuation(f.store, rotated, task.guided!.plan.workflowPolicy);
    assert.equal(decision.resume, true, decision.reason);
    assert.equal(decision.turns, 1);
    prepareWorkspaceContinuation(f.store, execution.id);
    assert.equal(f.store.session(session.id).providerSessionId, 'second-conversation');
    assert.equal(f.store.sessionEvents(session.id, ['turn.requested']).length, 3);
  },
);
