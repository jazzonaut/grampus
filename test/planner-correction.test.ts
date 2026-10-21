// Exercises invalid planner proposals at the durable kickoff boundary, before approval or execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import type { Connector, Reply, TurnResult } from '../src/providers/types.js';
import { fixture } from './helpers/guided-tasks.js';

const completed = (text: string): TurnResult => ({
  status: 'completed',
  reply: { kind: 'message', text, questions: [], findings: [] },
  usage: null,
  error: null,
});

test('a completed plan with independently worded slice criteria gets feedback and a fresh correction turn', async t => {
  const f = fixture(t);
  const sliceCriteria = ['The greeting appears on stdout', 'The output has a trailing newline'];
  const invalid = {
    ...f.plan,
    brief: {
      ...f.plan.brief,
      slices: [{ title: 'Greeting', plan: 'Preserve output behaviour', criteria: sliceCriteria }],
    },
  };
  const criteria = [...f.plan.brief.criteria, ...sliceCriteria];
  const corrected = {
    ...invalid,
    brief: { ...invalid.brief, criteria, slices: [{ ...invalid.brief.slices[0]!, criteria }] },
  };
  const prompts: string[] = [];
  const connector: Connector = async (_, options) => ({
    turn: async prompt => {
      prompts.push(prompt);
      options.emit({ type: 'session.connected', data: { providerSessionId: 'offline-planning', model: null } });
      if (prompts.length === 1) return completed(JSON.stringify(invalid));
      assert.ok(f.store.sessionEvents(id).some(event => event.type === 'kickoff.error'));
      assert.equal(f.store.list().length, 0);
      assert.equal(f.store.workspaces().length, 0);
      return completed(JSON.stringify(corrected));
    },
    interrupt: async () => {},
    close: async () => {},
  });
  const planners = new Kickoffs(f.store, connector);
  const id = planners.create({ repo: f.repo, request: 'Preserve the greeting' });
  const view = await planners.send(id);
  assert.equal(view.error, null);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /Slice criteria must name distinct approved task criteria/);
  assert.match(prompts[1]!, /brief\.criteria/);
  assert.deepEqual(view.candidate!.brief.criteria, criteria, 'the planner preserves and reconciles every requirement');
  const turns = f.store.sessionEvents(id).filter(event => event.type === 'turn.requested');
  assert.equal(turns.length, 2);
  assert.notDeepEqual(turns[0]!.data, turns[1]!.data, 'correction is a new durable dispatch');
  const task = f.store.get(planners.prepare(id, view.candidateDigest!));
  assert.equal(task.approvedVersion, null);
  assert.deepEqual(task.brief.criteria, criteria);
});

test('repeated malformed proposals exhaust a bounded correction and retain feedback on an explicit continuation', async t => {
  const f = fixture(t);
  const prompts: string[] = [];
  const planners = new Kickoffs(f.store, async () => ({
    turn: async prompt => {
      prompts.push(prompt);
      return completed(prompts.length <= 2 ? '{' : JSON.stringify(f.plan));
    },
    interrupt: async () => {},
    close: async () => {},
  }));
  const id = planners.create({ repo: f.repo, request: 'Preserve the greeting' });
  const failed = await planners.send(id);
  assert.equal(prompts.length, 2);
  assert.ok(failed.error);
  assert.equal(failed.candidate, null);
  assert.equal(failed.session.phase, 'idle');
  assert.throws(() => planners.prepare(id), /errors/);
  await assert.rejects(planners.send(id), /Supply a revision/);
  assert.equal(prompts.length, 2);
  const continued = await planners.send(id, 'Correct the proposed plan');
  assert.equal(continued.error, null);
  assert.ok(prompts[2]!.includes(failed.error));
  assert.equal(f.store.workspaces().length, 0);
});

test('the planner may ask a consequential question during correction instead of inventing an answer', async t => {
  const f = fixture(t);
  let turns = 0;
  const question: Reply = {
    kind: 'question',
    text: 'Confirm the expected output',
    questions: [{ id: 'output', prompt: 'Keep the newline?', choices: ['yes', 'no'] }],
    findings: [],
  };
  const planners = new Kickoffs(f.store, async () => ({
    turn: async () => {
      turns++;
      return turns === 1 ? completed('{') : { ...completed(''), reply: question };
    },
    interrupt: async () => {},
    close: async () => {},
  }));
  const id = planners.create({ repo: f.repo, request: 'Preserve the greeting' });
  const view = await planners.send(id);
  assert.equal(turns, 2);
  assert.equal(view.session.phase, 'awaiting_answer');
  assert.equal(view.error, null);
  assert.equal(view.candidate, null);
  await assert.rejects(planners.send(id, 'Continue'), /Answer every/);
});

test('provider failures, interruptions and unconfirmed shutdown never trigger plan correction', async t => {
  const f = fixture(t);
  for (const outcome of ['failed', 'interrupted', 'unconfirmed'] as const) {
    let turns = 0;
    const planners = new Kickoffs(f.store, async () => ({
      turn: async () => {
        turns++;
        return outcome === 'unconfirmed'
          ? completed('{')
          : { status: outcome, reply: null, usage: null, error: 'Provider stopped' };
      },
      interrupt: async () => {},
      close: async () => {
        if (outcome === 'unconfirmed') throw new Error('Cannot confirm exit');
      },
    }));
    const id = planners.create({ repo: f.repo, request: 'Preserve the greeting' });
    const view = await planners.send(id);
    assert.equal(turns, 1);
    assert.ok(view.error);
    assert.equal(view.candidate, null);
    assert.equal(view.session.phase, outcome === 'unconfirmed' ? 'recovery_required' : outcome);
  }
});

test('a context change after settlement prevents an obsolete proposal from starting a correction turn', async t => {
  const f = fixture(t);
  let turns = 0;
  const planners = new Kickoffs(f.store, async () => ({
    turn: async () => {
      turns++;
      return completed('{');
    },
    interrupt: async () => {},
    close: async () => {},
  }));
  const id = planners.create({ repo: f.repo, request: 'Preserve the greeting' });
  const transaction = f.store.transaction.bind(f.store);
  let changed = false;
  t.mock.method(f.store, 'transaction', <T>(action: () => T): T => {
    if (
      !changed &&
      f.store.session(id).phase === 'idle' &&
      f.store.sessionEvents(id).some(event => event.type === 'turn.result')
    ) {
      changed = true;
      const current = planners.view(id);
      planners.changeContext(id, ['greeting.js'], current.turnKey);
    }
    return transaction(action);
  });
  const view = await planners.send(id);
  assert.equal(turns, 1);
  assert.equal(view.candidate, null);
  assert.match(view.error!, /newer planning request or context/i);
});

test('cancelling after a completed invalid proposal prevents dispatching its correction', async t => {
  const f = fixture(t);
  const abort = new AbortController();
  let turns = 0;
  const planners = new Kickoffs(f.store, async () => ({
    turn: async () => {
      turns++;
      return completed('{');
    },
    interrupt: async () => {},
    close: async () => {},
  }));
  const id = planners.create({ repo: f.repo, request: 'Preserve the greeting' });
  const transaction = f.store.transaction.bind(f.store);
  t.mock.method(f.store, 'transaction', <T>(action: () => T): T => {
    if (f.store.session(id).phase === 'idle' && f.store.sessionEvents(id).some(event => event.type === 'turn.result'))
      abort.abort();
    return transaction(action);
  });
  const view = await planners.send(id, undefined, undefined, abort.signal);
  assert.equal(turns, 1);
  assert.equal(f.store.sessionEvents(id).filter(event => event.type === 'turn.requested').length, 1);
  assert.equal(view.candidate, null);
  assert.match(view.error!, /Planning interrupted/);
});
