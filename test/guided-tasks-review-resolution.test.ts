// A review that claims a pass must resolve every blocker even when partial progress permits another repair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, review, inlineImplementation, windows } from './helpers/guided-tasks.js';

test('a passing verdict with an unresolved prior blocker cannot reach acceptance or delivery', windows, async t => {
  const f = fixture(t),
    config = services();
  let edits = 0,
    reviews = 0;
  config.implementationRunner = options =>
    inlineImplementation(options, `// Edit ${++edits}\nconsole.log('hello world');\n`);
  config.connector = async () => ({
    turn: async prompt => {
      const line = /Prior blocking findings to account for:\n([^\n]+)/.exec(prompt);
      const prior = line ? (JSON.parse(line[1]!) as { id: string }[]) : [];
      return {
        status: 'completed',
        usage: null,
        error: null,
        reply: {
          ...review,
          priorFindings: prior.map((item, index) => ({
            id: item.id,
            status: index === 0 ? 'resolved' : 'unresolved',
            evidence: 'Inspected this requirement on the current artifact',
          })),
          findings:
            ++reviews === 1
              ? [
                  { severity: 'blocking', description: 'Activation jumps', evidence: 'Abrupt admission' },
                  { severity: 'blocking', description: 'Missing barrier coverage', evidence: 'No rendered assertion' },
                ]
              : [],
        },
      };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, quality: { passes: [] }, workflowPolicy: { mode: 'automatic' } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const result = await tasks.run(task.id);
  assert.equal(result.stopReason?.code, 'REVIEW_NO_PROGRESS', result.note);
  assert.equal(edits, 2);
  assert.equal(f.store.deliveries(result.executionId!).length, 0);
  assert.ok(!f.store.checks(result.executionId!).some(check => check.purpose === 'verification'));
});
