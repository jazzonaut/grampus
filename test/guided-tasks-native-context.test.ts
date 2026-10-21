// Fresh native conversations retain consequential answers, progress and approved reference identities.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions } from '../src/execution/sessions.js';
import { prepareWorkspaceContinuation } from '../src/execution/workspace-context.js';
import { inspectReference } from '../src/repository/reference-folders.js';
import { fixture, message, windows } from './helpers/guided-tasks.js';

test('rotation after an answered question retains the decision and latest progress', windows, async t => {
  const f = fixture(t);
  const task = f.tasks.create({ ...f.plan, workflowPolicy: { mode: 'supervised', maxSessionTurns: 1 } });
  f.tasks.approve(task.id, 1, task.guided!.digest);
  const state = await f.tasks.run(task.id);
  const execution = f.store.execution(state.executionId!);
  const sessions = new Sessions(f.store);
  const question = {
    kind: 'question' as const,
    text: 'Output decision',
    findings: [],
    questions: [{ id: 'punctuation', prompt: 'Which punctuation should the output use?', choices: [] }],
  };
  const first = sessions.claim(execution.sessionId, 'Implement', undefined, true);
  sessions.event(execution.sessionId, first.runId, {
    type: 'session.connected',
    data: { providerSessionId: 'first-conversation', model: 'fixture' },
  });
  sessions.settle(
    execution.sessionId,
    first.runId,
    {
      status: 'completed',
      reply: question,
      usage: null,
      error: null,
    },
    true,
  );
  const second = sessions.claim(execution.sessionId, 'Continue', { punctuation: 'Use no punctuation' }, true);
  sessions.settle(
    execution.sessionId,
    second.runId,
    {
      status: 'completed',
      reply: { ...message, kind: 'message', text: 'Remaining work: inspect the rendered greeting.' },
      usage: null,
      error: null,
    },
    true,
  );
  prepareWorkspaceContinuation(f.store, execution.id);
  assert.equal(sessions.get(execution.sessionId).providerSessionId, null);
  const third = sessions.claim(execution.sessionId, 'Continue', undefined, true);
  assert.match(third.prompt, /Which punctuation should the output use/);
  assert.match(third.prompt, /Use no punctuation/);
  assert.match(third.prompt, /Remaining work: inspect the rendered greeting/);
  sessions.settle(
    execution.sessionId,
    third.runId,
    { status: 'completed', reply: message, usage: null, error: null },
    true,
  );
});

test('native implementation receives the approved pinned reference folders', windows, async t => {
  const f = fixture(t);
  const reference = inspectReference(f.repo);
  const task = f.tasks.create({ ...f.plan, references: [reference] });
  f.tasks.approve(task.id, 1, task.guided!.digest);
  const state = await f.tasks.run(task.id);
  const execution = f.store.execution(state.executionId!);
  const sessions = new Sessions(f.store);
  const claim = sessions.claim(execution.sessionId, 'Implement', undefined, true);
  assert.ok(claim.prompt.includes(JSON.stringify(reference.path).slice(1, -1)), 'selected references are supplied');
  assert.ok(claim.prompt.includes(reference.base!), 'reference content retains its approved identity');
  sessions.settle(
    execution.sessionId,
    claim.runId,
    { status: 'completed', reply: message, usage: null, error: null },
    true,
  );
});
