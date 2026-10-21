// A question can retain provisional review findings without supplying a passing review or lens evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../src/providers/types.js';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { fixture, services, windows } from './helpers/guided-tasks.js';

const question = {
  kind: 'question',
  text: 'Clarify capture inspection',
  questions: [{ id: 'capture', prompt: 'Who inspects the captures?', choices: ['The user'] }],
  findings: [
    {
      severity: 'blocking',
      description: 'Expiry assertion permits residue',
      evidence: 'The pixel bound allows remaining smoke.',
    },
  ],
  lenses: [{ lens: 'simplification', verdict: 'fail', summary: 'The assertion needs repair.', findings: [] }],
  priorFindings: [{ id: 'previous', status: 'unresolved', evidence: 'The same assertion remains.' }],
};

test('reviewer questions preserve provisional lenses and prior findings through reply validation', () => {
  const reply = parseReply(question);
  assert.equal(reply.kind, 'question');
  assert.equal(reply.lenses?.[0]?.verdict, 'fail');
  assert.equal(reply.priorFindings?.[0]?.status, 'unresolved');
  assert.throws(() => parseReply({ ...question, kind: 'message', questions: [] }), /Only a review/);
});

test(
  'a reviewer question with findings waits for an answer without recording passing review evidence',
  windows,
  async t => {
    const f = fixture(t),
      config = services();
    config.connector = async () => ({
      turn: async () => ({ status: 'completed', reply: parseReply(question), usage: null, error: null }),
      interrupt: async () => {},
      close: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
    tasks.approve(task.id, 1, task.guided!.digest);
    const state = await tasks.run(task.id);
    assert.equal(state.status, 'awaiting_answer', state.note);
    assert.equal(state.stopReason?.code, 'AGENT_QUESTION');
    const view = guidedTaskView(f.store, task.id);
    assert.equal(view.findings[0]?.description, question.findings[0]!.description);
    assert.equal(view.lenses[0]?.verdict, 'fail');
    assert.ok(!view.task.evidence.some(evidence => evidence.kind === 'review' && evidence.outcome === 'passed'));
  },
);
