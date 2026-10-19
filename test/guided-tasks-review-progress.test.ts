// Exercises productive review repairs and their shared allowance against real Git and SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { fixture, services, review, inlineImplementation, windows } from './helpers/guided-tasks.js';

test('productive review repair journals its decision and shared spend through delivery', windows, async t => {
  const f = fixture(t);
  let edits = 0;
  let reviews = 0;
  const config = services();
  config.implementationRunner = options =>
    inlineImplementation(options, `// Attempt ${++edits}\nconsole.log('hello world');\n`);
  config.connector = async () => ({
    turn: async prompt => {
      const prior = /Prior blocking findings to account for:\n([^\n]+)/.exec(prompt);
      const findings = prior ? (JSON.parse(prior[1]!) as { id: string }[]) : [];
      return {
        status: 'completed',
        reply: {
          ...review,
          priorFindings: findings.map(item => ({
            id: item.id,
            status: 'resolved',
            evidence: 'Checked the changed source.',
          })),
          findings:
            ++reviews === 1
              ? [
                  {
                    severity: 'blocking',
                    description: `Related defect ${reviews}`,
                    evidence: 'Concrete source evidence',
                  },
                ]
              : [],
        },
        usage: null,
        error: null,
      };
    },
    close: async () => {},
    interrupt: async () => {},
  });
  const tasks = new GuidedTasks(f.store, config);
  const task = tasks.create({ ...f.plan, workflowPolicy: { mode: 'automatic' }, quality: { passes: [] } });
  tasks.approve(task.id, 1, task.guided!.digest);
  const done = await tasks.run(task.id);
  assert.equal(done.status, 'complete', done.note);
  assert.equal(edits, 2);
  const decisions = f.store.events(task.id).filter(event => event.type === 'guided.repair_decided');
  assert.equal(decisions.length, 1);
  assert.equal(done.repairCycle.used, 1);
});
