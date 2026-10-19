// Exercises durable guidance proposals without starting a provider or changing the approved plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedDecisionKey } from '../src/orchestration/guided/keys.js';
import { fixture } from './helpers/guided-tasks.js';
import { guidanceLimits } from '../src/config/limits.js';
import { guidanceView } from '../src/server/view-model/guidance.js';

test('guidance queues and cancels without inference, plan changes or stale decisions', t => {
  const f = fixture(t),
    id = f.create();
  const before = f.tasks.get(id);
  const oldKey = guidedDecisionKey(before);
  const queued = f.tasks.queueGuidance(id, 'Keep the implementation direct.', 'implementer');
  assert.equal(queued.guidance.length, 1);
  assert.equal(queued.guidance[0]!.text, 'Keep the implementation direct.');
  assert.equal(queued.digest, before.digest);
  assert.equal(queued.status, 'ready');
  assert.deepEqual(f.store.sessions(), []);
  assert.notEqual(guidedDecisionKey(queued), oldKey);
  assert.throws(
    () => new GuidedTasks(f.store, { expectedState: oldKey }).queueGuidance(id, 'Stale message', 'next_agent'),
    /changed since/,
  );
  const cancelled = f.tasks.cancelGuidance(id, queued.guidance[0]!.id);
  assert.deepEqual(cancelled.guidance, []);
  assert.equal(f.store.events(id, ['guided.guidance_queued']).length, 1);
  assert.equal(f.store.events(id, ['guided.guidance_cancelled']).length, 1);
  const history = guidanceView(id, cancelled, f.store.events(id), guidedDecisionKey(cancelled), true, false);
  assert.equal(history.messages[0]!.status, 'cancelled');
});

test('guidance refuses unapproved plans, blank text and oversized UTF-8 input', t => {
  const f = fixture(t);
  const draft = f.tasks.create(f.plan);
  assert.throws(() => f.tasks.queueGuidance(draft.id, 'Do not broaden scope.', 'next_agent'), /Approve/);
  f.tasks.approve(draft.id, 1, draft.guided!.digest);
  assert.throws(() => f.tasks.queueGuidance(draft.id, '  ', 'next_agent'), /guidance/i);
  assert.throws(() => f.tasks.queueGuidance(draft.id, '🦑'.repeat(2000), 'next_agent'), /bytes/);
  assert.deepEqual(f.tasks.get(draft.id).guidance, []);
});

test('a failed guidance journal write rolls back the queue and its decision key', t => {
  const f = fixture(t),
    id = f.create();
  const before = f.tasks.get(id);
  const append = f.store.append.bind(f.store);
  f.store.append = (...args) => {
    if (args[2] === 'guided.guidance_queued') throw new Error('Injected journal failure');
    append(...args);
  };
  assert.throws(() => f.tasks.queueGuidance(id, 'Keep this atomic.', 'next_agent'), /Injected journal failure/);
  assert.deepEqual(f.tasks.get(id), before);
  assert.equal(guidedDecisionKey(f.tasks.get(id)), guidedDecisionKey(before));
  assert.deepEqual(f.store.events(id, ['guided.guidance_queued']), []);
});

test('the queue is bounded and revision expires pending guidance instead of carrying it into new approval', async t => {
  const f = fixture(t),
    id = f.create();
  for (let count = 0; count < guidanceLimits.pendingMessages; count++)
    f.tasks.queueGuidance(id, `Approach ${count}`, 'implementer');
  assert.throws(() => f.tasks.queueGuidance(id, 'Too many', 'next_agent'), /At most/);
  const revised = await f.tasks.revise(id, f.plan);
  assert.equal(revised.version, 2);
  assert.deepEqual(revised.guidance, []);
  const history = guidanceView(id, revised, f.store.events(id), guidedDecisionKey(revised), false, false);
  assert.ok(history.messages.every(message => message.status === 'expired'));
  assert.equal(history.compose, null);
});

test('history expires restored guidance after revision instead of retaining its old assignment', async t => {
  const f = fixture(t),
    id = f.create();
  const message = f.tasks.queueGuidance(id, 'Keep the restored approach direct.', 'implementer').guidance[0]!;
  f.store.append(id, 1, 'guided.step_requested', { pending: { stage: 'implementation', guidance: [message] } });
  f.store.append(id, 1, 'guided.step_reconciled', { restoredGuidance: [message.id] });
  const revised = await f.tasks.revise(id, f.plan);
  const history = guidanceView(id, revised, f.store.events(id), guidedDecisionKey(revised), false, false);
  assert.equal(history.messages[0]!.status, 'expired');
});
