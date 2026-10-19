// Task usage tests: cumulative provider counters across resumed sessions (continuing and reset),
// attribution to workflow stages, turn counters, wall time and human interventions after approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { Workflow } from '../src/domain/workflow.js';
import { taskUsage, usageLines, usageTable } from '../src/reporting/task-usage.js';
import type { Usage, Provider } from '../src/providers/types.js';
import type { Execution, ExecutionStage, TurnStage, Workspace } from '../src/persistence/records.js';

const usage = (inputTokens: number, extra: Partial<Omit<Usage, 'scope' | 'billedCostUsd'>> = {}): Usage => ({
  scope: 'provider-session-cumulative',
  inputTokens,
  outputTokens: inputTokens / 2,
  cachedInputTokens: 0,
  cacheWriteInputTokens: null,
  estimatedCostUsd: null,
  billedCostUsd: null,
  ...extra,
});

function journal(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = new Workflow(store).create({
    title: 'Usage',
    outcome: 'Report measurements',
    criteria: ['Measured totals'],
    plan: 'Read retained usage',
  });
  const sessions = new Sessions(store);
  /** A planning session linked to the task, with the given provider conversation id. */
  const planning = (provider: Provider, providerSessionId: string) => {
    const session = sessions.create(provider, process.cwd());
    session.providerSessionId = providerSessionId;
    store.saveSession(session.id, session);
    store.append(task.id, 1, 'guided.kickoff_linked', { sessionId: session.id });
    return session.id;
  };
  let workspaceId: string | null = null;
  /** An execution of the task in `stage`, bound to a fresh session continuing `providerSessionId`. */
  const execution = (stage: ExecutionStage, provider: Provider, providerSessionId: string) => {
    if (!workspaceId) {
      workspaceId = randomUUID();
      const workspace: Workspace = {
        id: workspaceId,
        taskId: task.id,
        version: 1,
        adapter: 'git',
        repository: process.cwd(),
        commonDirectory: process.cwd(),
        path: process.cwd(),
        branch: 'grampus/usage',
        baseCommit: 'base',
        host: 'host',
        phase: 'ready',
        owner: null,
      };
      store.saveWorkspace(workspaceId, task.id, randomUUID(), workspace);
    }
    const session = sessions.create(provider, process.cwd());
    session.providerSessionId = providerSessionId;
    store.saveSession(session.id, session);
    const record: Execution = {
      stage,
      sliceIndex: 0,
      id: randomUUID(),
      taskId: task.id,
      version: 1,
      attemptId: randomUUID(),
      workspaceId,
      sessionId: session.id,
      role: stage === 'review' || stage === 'arbitration' ? 'review' : 'implementation',
      phase: 'closed',
      headAtCreation: 'base',
      artifact: null,
      fallbackReason: null,
    };
    store.saveExecution(record.id, task.id, workspaceId, session.id, record);
    return session.id;
  };
  /** One provider turn as the journal records it: request, observations, then the result. */
  const turn = (
    sessionId: string,
    stage: TurnStage,
    samples: Usage[],
    result: { status?: 'completed' | 'failed' | 'interrupted'; usage?: Usage | null } | null = {},
  ) => {
    const runId = randomUUID();
    store.appendSession(sessionId, 'turn.requested', { runId, stage, prompt: 'Work', autoRetries: 0 });
    for (const sample of samples) store.appendSession(sessionId, 'usage.updated', { runId, data: sample });
    if (result)
      store.appendSession(sessionId, 'turn.result', {
        runId,
        result: {
          status: result.status ?? 'completed',
          reply: null,
          usage: result.usage === undefined ? (samples.at(-1) ?? null) : result.usage,
          error: null,
        },
        exitConfirmed: true,
      });
  };
  return { store, task, sessions, planning, execution, turn };
}

test('task usage counts cumulative sessions once, includes planning and marks incomplete observations', t => {
  const { store, task, planning, turn } = journal(t);
  const a = planning('codex', 'shared-thread');
  turn(a, 'planning', [usage(100), usage(150)]);
  const resumed = planning('codex', 'shared-thread');
  turn(resumed, 'planning', [], { usage: usage(200) });
  const b = planning('codex', 'independent-thread');
  turn(b, 'planning', [], { usage: usage(40) });
  const c = planning('claude', 'claude-thread');
  turn(c, 'planning', [], { usage: usage(90, { estimatedCostUsd: 0.02 }) });
  const rows = taskUsage(store, task.id).providers;
  assert.equal(rows[0]!.inputTokens, 240);
  assert.equal(rows[0]!.sessions, 2);
  assert.equal(rows[0]!.estimatedCostUsd, null);
  assert.equal(rows[0]!.cacheWriteInputTokens, null, 'an unreported counter stays unknown, not zero');
  assert.equal(rows[0]!.billedCostUsd, null);
  assert.equal(rows[1]!.inputTokens, 90);
  assert.equal(rows[1]!.estimatedCostUsd, 0.02);
  assert.ok(!rows[0]!.incomplete.includes('inputTokens'));
  turn(b, 'planning', [], { status: 'interrupted', usage: null });
  turn(planning('codex', 'missing-thread'), 'planning', [], null);
  const partial = taskUsage(store, task.id);
  assert.equal(partial.providers[0]!.inputTokens, 240);
  assert.equal(partial.providers[0]!.sessions, 3);
  assert.ok(partial.providers[0]!.incomplete.includes('inputTokens'));
  assert.equal(partial.unsettledTurns, 1);
  assert.equal(partial.interruptedTurns, 1);
  assert.match(usageLines(partial).join('\n'), /input tokens 240 \(partial\)/);
  assert.match(usageLines(taskUsage(store, new Workflow(store).create(task.brief).id)).join('\n'), /unknown/);
});

test('live usage remains partial, refreshes after interruption and is replaced by a final snapshot', t => {
  const { store, task, sessions } = journal(t);
  const session = sessions.create('claude', process.cwd());
  store.append(task.id, 1, 'guided.kickoff_linked', { sessionId: session.id });
  const claim = sessions.claim(session.id, 'Work');
  const live: Usage = usage(100, { complete: false, outputTokens: 40, cachedInputTokens: 2000, estimatedCostUsd: 0.2 });
  sessions.event(session.id, claim.runId, { type: 'usage.updated', data: live });
  const running = taskUsage(store, task.id);
  assert.equal(running.providers[0]!.inputTokens, 100);
  assert.equal(running.providers[0]!.activeSessions, 1);
  assert.equal(running.providers[0]!.observedSessions, 1);
  assert.ok(running.providers[0]!.incomplete.includes('inputTokens'));
  assert.ok(running.providers[0]!.updatedAt);
  assert.equal(running.stages[0]!.stage, 'planning');
  assert.equal(running.stages[0]!.unsettledTurns, 1);
  assert.equal(running.stages[0]!.wallMs, null, 'an unsettled turn has no wall time yet');
  sessions.settle(session.id, claim.runId, { status: 'interrupted', reply: null, usage: null, error: 'Stopped' }, true);
  const stopped = taskUsage(store, task.id);
  assert.equal(stopped.providers[0]!.inputTokens, 100);
  assert.equal(stopped.providers[0]!.activeSessions, 0);
  assert.ok(stopped.providers[0]!.incomplete.includes('inputTokens'));
  assert.equal(stopped.stages[0]!.interruptedTurns, 1);
  assert.notEqual(stopped.stages[0]!.wallMs, null);
  store.appendSession(session.id, 'usage.updated', { data: { ...live, complete: true, inputTokens: 120 } });
  const final = taskUsage(store, task.id).providers[0]!;
  assert.equal(final.inputTokens, 120);
  assert.equal(final.sessions, 1);
  assert.equal(final.incomplete.length, 0);
});

test('Claude counters continue across resumed SDK processes and are attributed per turn', t => {
  // Recorded shape from the pinned SDK: each process resumes the session and its samples and result
  // already include the earlier turns, so a later process starts at the previous total.
  const { store, task, planning, execution, turn } = journal(t);
  const claude = (input: number, read: number, write: number, cost: number, complete = true): Usage =>
    usage(input, {
      outputTokens: input * 2,
      cachedInputTokens: read,
      cacheWriteInputTokens: write,
      estimatedCostUsd: cost,
      complete,
    });
  const plan = planning('claude', 'claude-session');
  turn(plan, 'planning', [claude(962, 0, 3229, 0.0185, false), claude(962, 0, 3229, 0.0185)]);
  const implement = execution('implementation', 'claude', 'claude-session');
  turn(implement, 'implementation', [claude(964, 1864, 3685, 0.0227, false), claude(964, 1864, 3685, 0.0227)]);
  turn(implement, 'quality_pass', [claude(966, 4159, 3750, 0.0237)]);
  const usageNow = taskUsage(store, task.id);
  const total = usageNow.providers[0]!;
  assert.equal(total.sessions, 1);
  assert.equal(total.inputTokens, 966);
  assert.equal(total.cachedInputTokens, 4159);
  assert.equal(total.cacheWriteInputTokens, 3750);
  assert.equal(total.estimatedCostUsd!.toFixed(4), '0.0237');
  assert.deepEqual(total.incomplete, []);
  const byStage = Object.fromEntries(usageNow.stages.map(row => [row.stage, row]));
  assert.equal(byStage['planning']!.inputTokens, 962);
  assert.equal(byStage['planning']!.cacheWriteInputTokens, 3229);
  assert.equal(byStage['implementation']!.inputTokens, 2);
  assert.equal(byStage['implementation']!.cachedInputTokens, 1864);
  assert.equal(byStage['implementation']!.cacheWriteInputTokens, 456);
  assert.equal(byStage['quality_pass']!.cachedInputTokens, 2295);
  assert.match(usageTable(usageNow).join('\n'), /\| quality_pass \| claude \| 1 \| 0 \| 0 \|/);
});

test('counters that restart in a resumed process are summed per turn instead of replaced', t => {
  // A transcript without saved totals restarts the counters at zero: the later, smaller snapshot is
  // that process's own usage, not a correction of the earlier total.
  const { store, task, execution, turn } = journal(t);
  const first = execution('implementation', 'claude', 'restarted-session');
  turn(first, 'implementation', [usage(100, { estimatedCostUsd: 0.1 })]);
  const second = execution('repair', 'claude', 'restarted-session');
  turn(second, 'repair', [
    usage(20, { complete: false, estimatedCostUsd: 0.02 }),
    usage(60, { estimatedCostUsd: 0.06 }),
  ]);
  const result = taskUsage(store, task.id);
  assert.equal(result.providers[0]!.inputTokens, 160);
  assert.equal(result.providers[0]!.estimatedCostUsd!.toFixed(2), '0.16');
  assert.equal(result.stages.find(row => row.stage === 'repair')!.inputTokens, 60);
  assert.equal(result.repairAttempts, 1);
});

test('Codex thread totals continue across thread/resume; an unobserved turn keeps totals right but partial', t => {
  // Recorded from codex app-server 0.163: thread/resume in a new process reports the restored total
  // before the next turn, and later notifications continue from it.
  const { store, task, execution, turn } = journal(t);
  const codex = (input: number, cached: number, output: number): Usage =>
    usage(input, { cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output });
  const review = execution('review', 'codex', 'codex-thread');
  turn(review, 'review', [codex(16668, 12544, 5)]);
  const again = execution('review', 'codex', 'codex-thread');
  turn(again, 'review', [], { status: 'failed', usage: null });
  const arbitration = execution('arbitration', 'codex', 'codex-thread');
  turn(arbitration, 'arbitration', [codex(16668, 12544, 5), codex(33359, 29056, 10)]);
  const result = taskUsage(store, task.id);
  const total = result.providers[0]!;
  assert.equal(total.inputTokens, 33359);
  assert.equal(total.outputTokens, 10);
  assert.equal(total.cacheWriteInputTokens, 0);
  assert.ok(total.incomplete.includes('inputTokens'), 'the failed turn has no measurement of its own');
  const reviewRow = result.stages.find(row => row.stage === 'review')!;
  assert.equal(reviewRow.turns, 2);
  assert.equal(reviewRow.failedTurns, 1);
  assert.equal(reviewRow.inputTokens, 16668);
  assert.equal(result.stages.find(row => row.stage === 'arbitration')!.inputTokens, 16691);
  assert.equal(result.failedTurns, 1);
});

test('human interventions count user actions after the first approval only', t => {
  const { store, task } = journal(t);
  for (const type of [
    'guided.created',
    'guided.revised',
    'guided.approved',
    'guided.controller_claimed',
    'guided.answers_supplied',
    'guided.scope_authorized',
    'guided.assessment_supplied',
    'guided.retry_requested',
    'guided.preparation_retry_requested',
    'guided.checks_rerun_requested',
    'guided.recovery_requested',
    'guided.workspace_released',
    'guided.stop_requested',
    'guided.pause_requested',
    'guided.guidance_queued',
    'guided.guidance_cancelled',
    'guided.revised',
    'guided.approved',
    'guided.step_finished',
  ])
    store.append(task.id, 1, type, {});
  const { interventions } = taskUsage(store, task.id);
  assert.deepEqual(interventions, {
    total: 14,
    answers: 1,
    authorizations: 1,
    assessments: 1,
    retries: 2,
    rerunChecks: 1,
    recoveries: 2,
    revisions: 1,
    stops: 2,
    approvals: 1,
    guidance: 2,
  });
  assert.match(usageLines(taskUsage(store, task.id)).join('\n'), /unknown/, 'no provider usage yet');
});
