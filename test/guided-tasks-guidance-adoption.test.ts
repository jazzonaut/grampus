// Recovery adopts completed work without assigning the same human message a second time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, windows, crashProgram } from './helpers/guided-tasks.js';

test('recovery of a completed implementation consumes its guidance once without replay', windows, async t => {
  const f = fixture(t),
    id = f.create();
  await f.tasks.run(id);
  const message = f.tasks.queueGuidance(id, 'Keep the implementation direct.', 'implementer').guidance[0]!;
  crashProgram(f, 'authorize', 'validation', id);
  const before = f.tasks.get(id);
  assert.equal(before.pending!.guidance[0]!.id, message.id);
  assert.deepEqual(before.guidance, []);
  const recovered = await f.tasks.recover(id);
  assert.equal(recovered.status, 'ready', recovered.note);
  assert.equal(recovered.stage, 'validation');
  assert.equal(recovered.pending, null);
  assert.deepEqual(recovered.guidance, []);
  assert.equal(f.store.implementations(recovered.executionId!).length, 1);
  const checkpoint = await f.tasks.run(id);
  assert.equal(checkpoint.status, 'awaiting_assessment', checkpoint.note);
  assert.deepEqual(checkpoint.guidance, []);
  assert.equal(f.store.implementations(checkpoint.executionId!).length, 1);
  const assignments = f.store.events(id, ['guided.step_requested']).filter(event => {
    const { pending } = event.data as { pending: { guidance: { id: string }[] } };
    return pending.guidance.some(item => item.id === message.id);
  });
  assert.equal(assignments.length, 1);
});
