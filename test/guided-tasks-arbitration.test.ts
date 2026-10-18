// Guided task tests: approved repair budgets and fresh arbitration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuidedTasks } from '../src/orchestration/guided-tasks.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import type { Reply } from '../src/providers/types.js';
import { renderReport } from '../src/reporting/report.js';
import { windows, review, services, fixture } from './helpers/guided-tasks.js';

test(
  'approved repair budget prepares a fresh authorization, retains findings and never infers simplification',
  windows,
  async t => {
    const f = fixture(t);
    let reviews = 0;
    const config = services();
    config.connector = async () => ({
      turn: async prompt => {
        reviews++;
        if (reviews > 1) assert.match(prompt, /Fix the concrete fixture issue/);
        return {
          status: 'completed',
          reply:
            reviews === 1
              ? {
                  ...review,
                  findings: [
                    {
                      severity: 'blocking',
                      description: 'Fix the concrete fixture issue',
                      evidence: 'Fixture regression must be rechecked',
                    },
                  ],
                }
              : review,
          usage: null,
          error: null,
        };
      },
      close: async () => {},
      interrupt: async () => {},
    });
    const tasks = new GuidedTasks(f.store, config),
      task = tasks.create({ ...f.plan, reviewPolicy: { repairRounds: 1 } }),
      id = task.id;
    tasks.approve(id, 1, task.guided!.digest);
    await tasks.run(id);
    const first = await tasks.authorize(id);
    assert.equal(first.status, 'awaiting_assessment', first.note);
    const repair = await tasks.assess(id, 'passed', 'Inspected initial implementation');
    assert.equal(repair.status, 'awaiting_scope', repair.note);
    assert.equal(repair.reviewCycle.repairs, 1);
    assert.notEqual(repair.executionId, first.executionId);
    assert.match(repair.feedback, /Fix the concrete/);
    const repairView = guidedTaskView(f.store, id);
    assert.equal(repairView.carriedFindings, true);
    assert.match(repairView.findings[0]!.description, /Fix the concrete/);
    assert.equal(f.store.deliveries(first.executionId!).length, 0);
    const second = await tasks.authorize(id);
    assert.equal(second.status, 'awaiting_assessment', second.note);
    const done = await tasks.assess(id, 'passed', 'Reinspected the repaired artifact and validation');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(reviews, 2);
  },
);

for (const passes of [true, false])
  test(
    `fresh approved arbitration ${passes ? 'passes with retained disagreement' : 'stops after an unresolved verdict'}`,
    windows,
    async t => {
      const f = fixture(t);
      let turns = 0;
      const blocking: Reply = {
        ...review,
        findings: [
          { severity: 'blocking', description: 'Concrete disagreement', evidence: 'The fixture contract is disputed' },
        ],
      };
      const config = services();
      config.connector = async provider => ({
        turn: async prompt => {
          turns++;
          if (turns === 2) {
            assert.equal(provider, 'codex');
            assert.match(prompt, /fresh arbitrator/);
            assert.match(prompt, /Concrete disagreement/);
          }
          return { status: 'completed', reply: turns === 2 && passes ? review : blocking, usage: null, error: null };
        },
        close: async () => {},
        interrupt: async () => {},
      });
      const tasks = new GuidedTasks(f.store, config),
        task = tasks.create({ ...f.plan, reviewPolicy: { repairRounds: 0, arbitrator: { provider: 'codex' } } }),
        id = task.id;
      tasks.approve(id, 1, task.guided!.digest);
      await tasks.run(id);
      await tasks.authorize(id);
      const result = await tasks.assess(id, 'passed', 'Inspected the submitted implementation');
      assert.equal(result.status, passes ? 'complete' : 'blocked', result.note);
      assert.equal(turns, 2);
      assert.equal(result.reviewCycle.arbitrationUsed, true);
      assert.equal(result.reviewCycle.history.length, passes ? 1 : 2);
      const history = renderReport(f.store, id);
      assert.match(history, /guided.arbitration_requested/);
      if (passes) assert.match(history, /review.same_provider_fallback/);
      else {
        assert.equal(f.store.deliveries(result.executionId!).length, 0);
        await assert.rejects(tasks.run(id), /blocked/);
      }
    },
  );
