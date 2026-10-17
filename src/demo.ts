import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Workflow, type Evidence } from './workflow.js';

/** Exercises the controller, not provider integration. Always marked synthetic. */
export function runDemo(path: string): string {
  let store = new Store(path);
  try {
    let workflow = new Workflow(store);
    const task = workflow.create({
      title: 'Grampus controller demonstration',
      outcome: 'Retain task history through an interrupted controller and verify a fresh attempt.',
      criteria: ['The example output is hello world', 'History survives reopening the journal'],
      plan: 'Synthetic implementation, simulated interruption, reconciliation, retry, check, review and verification.',
    }, true);
    workflow.approve(task.id, task.version);
    const agent = { provider: 'synthetic-codex', model: 'fixture', sessionId: randomUUID() };
    const interrupted = workflow.start(task.id, agent);
    store.close();
    store = new Store(path);
    workflow = new Workflow(store);
    // The demo owns this isolated database; no actual workers were ever started.
    workflow.recover();
    workflow.confirmStopped(task.id, interrupted.id, 'Synthetic attempt had no child process');
    const attempt = workflow.start(task.id, { ...agent, sessionId: randomUUID() });
    workflow.finish(task.id, interrupted.id, task.version, 'succeeded', 'fixture:obsolete', 'Simulated late response');
    workflow.finish(task.id, attempt.id, task.version, 'succeeded', 'fixture:hello-world', 'Synthetic implementation finished');
    for (const kind of ['simplification', 'validation', 'review', 'verification'] as const) {
      const evidence: Evidence = {
        id: randomUUID(), attemptId: attempt.id, version: task.version, artifact: 'fixture:hello-world',
        kind, outcome: 'passed', source: 'synthetic', summary: `Synthetic ${kind} fixture; no real agent or repository check`,
        criteria: task.brief.criteria,
      };
      if (kind === 'review') evidence.agent = { provider: 'synthetic-claude', model: 'fixture', sessionId: randomUUID() };
      workflow.record(task.id, evidence);
    }
    const decision = workflow.addDecision(task.id, 'Synthetic decision: use the representative output');
    workflow.acceptDecision(task.id, decision, task.version);
    workflow.complete(task.id);
    return task.id;
  } finally { store.close(); }
}
