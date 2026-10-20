// Verifies fixed repair choices through a real task, with only provider turns replaced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, inlineImplementation, review, lens, windows } from './helpers/guided-tasks.js';
const profiles = [
  {
    id: 'economy',
    name: 'Economy',
    planning: { provider: 'codex', model: 'planner' },
    implementation: { provider: 'codex', model: 'economy', effort: 'low' },
    review: { provider: 'claude', model: 'reviewer', effort: 'high' },
  },
];
test('repair uses its fixed model and effort without replaying an implementation conversation', windows, async t => {
  const f = fixture(t),
    config = services(),
    seen: { model: string | null; effort?: string }[] = [];
  config.implementationRunner = options => {
    const execution = f.store.execution(f.store.implementation(options.receipt!.checkId).executionId);
    const session = f.store.session(execution.sessionId);
    seen.push({ model: session.model, ...(session.effort ? { effort: session.effort } : {}) });
    return inlineImplementation(
      options,
      seen.length === 1 ? "console.log('wrong');\n" : "console.log('hello world');\n",
    );
  };
  config.connector = async () => ({
    turn: async () => ({
      status: 'completed',
      reply: { ...review, lenses: [lens('pass', 'Inspected')] },
      usage: null,
      error: null,
    }),
    interrupt: async () => {},
    close: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({
    ...f.plan,
    workflowPolicy: { mode: 'automatic' },
    modelProfile: { ...profiles[0], repair: { provider: 'codex', model: 'repairer', effort: 'high' } },
  });
  tasks.approve(task.id, 1, task.guided!.digest);
  const result = await tasks.run(task.id);
  assert.equal(result.status, 'complete', result.note);
  assert.deepEqual(seen, [
    { model: 'economy', effort: 'low' },
    { model: 'repairer', effort: 'high' },
  ]);
});
