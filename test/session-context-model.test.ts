// A changed model starts a new provider conversation with its own context measurements and turn count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions } from '../src/execution/sessions.js';
import { sessionContinuation } from '../src/execution/session-context.js';
import { agentToolsetVersion } from '../src/providers/types.js';
import { defaultSettings } from '../src/config/settings.js';
import { fixture } from './helpers/guided-tasks.js';

test('model reassignment excludes the previous conversation from rotation limits', t => {
  const f = fixture(t),
    sessions = new Sessions(f.store);
  const session = sessions.create('codex', f.repo, 'writer');
  f.store.transaction(() => {
    for (const runId of ['old-first', 'old-second']) {
      f.store.appendSession(session.id, 'turn.requested', { runId });
      f.store.appendSession(session.id, 'turn.result', { runId, result: { status: 'completed' } });
    }
    f.store.appendSession(session.id, 'context.updated', { data: { inputTokens: 200_000 } });
  });
  sessions.assign(session.id, { provider: 'codex', model: 'documenter' });
  const assigned = sessions.get(session.id);
  assigned.providerSessionId = 'documenter-conversation';
  assigned.toolsetVersion = agentToolsetVersion;
  f.store.transaction(() => {
    f.store.saveSession(assigned.id, assigned);
    f.store.appendSession(assigned.id, 'turn.requested', { runId: 'new-first' });
    f.store.appendSession(assigned.id, 'turn.result', { runId: 'new-first', result: { status: 'completed' } });
  });
  const decision = sessionContinuation(f.store, assigned, {
    ...defaultSettings().defaultWorkflowPolicy,
    maxSessionTurns: 2,
  });
  assert.equal(decision.resume, true, decision.reason);
  assert.equal(decision.turns, 1);
  assert.equal(decision.inputTokens, null);
});
