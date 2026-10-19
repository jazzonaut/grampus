// Owns the synthetic `demo` command: one task through the workflow with a simulated controller
// restart, using a database the demo owns. It must never start a provider, worker or Git write, and
// everything it records is marked synthetic.
import { randomUUID } from 'node:crypto';
import { Store } from '../persistence/store.js';
import { Workflow, type Evidence } from '../domain/workflow.js';

/**
 * Exercises the controller, not provider integration. Always marked synthetic. Reopens the store to
 * show history surviving a restart, recovers the interrupted attempt and then delivers it a late result
 * that the workflow ignores. Returns the task id. `path` must be a database only the demo uses.
 */
export function runDemo(path: string): string {
  let store = new Store(path);
  try {
    let workflow = new Workflow(store);
    const task = workflow.create(
      {
        title: 'Grampus controller demonstration',
        outcome: 'Retain task history through an interrupted controller and verify a fresh attempt.',
        criteria: ['The example output is hello world', 'History survives reopening the journal'],
        plan: 'Synthetic implementation, simulated interruption, reconciliation, retry, check, review and verification.',
      },
      true,
    );
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
    // A late result for the stopped attempt; the workflow journals it as ignored.
    workflow.finish(task.id, interrupted.id, task.version, 'succeeded', 'fixture:obsolete', 'Simulated late response');
    workflow.finish(
      task.id,
      attempt.id,
      task.version,
      'succeeded',
      'fixture:hello-world',
      'Synthetic implementation finished',
    );
    for (const kind of ['quality', 'validation', 'review', 'verification'] as const) {
      const evidence: Evidence = {
        id: randomUUID(),
        attemptId: attempt.id,
        version: task.version,
        artifact: 'fixture:hello-world',
        kind,
        outcome: 'passed',
        source: 'synthetic',
        summary: `Synthetic ${kind} fixture; no real agent or repository check`,
        criteria: task.brief.criteria,
        ...(kind === 'quality' ? { pass: 'simplification' } : {}),
      };
      if (kind === 'review')
        evidence.agent = { provider: 'synthetic-claude', model: 'fixture', sessionId: randomUUID() };
      workflow.record(task.id, evidence);
    }
    const decision = workflow.addDecision(task.id, 'Synthetic decision: use the representative output');
    workflow.acceptDecision(task.id, decision, task.version);
    workflow.complete(task.id);
    return task.id;
  } finally {
    store.close();
  }
}
