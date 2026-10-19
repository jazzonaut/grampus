// Streamed output tests: provider deltas are coalesced per run, journaled before any other event of
// the run and at settlement, and flushed by size or interval without rewriting the session record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/persistence/store.js';
import { Sessions, runSession } from '../src/execution/sessions.js';
import { currentSettings, defaultSettings, useSettings } from '../src/config/settings.js';
import { plannerProgress } from '../src/orchestration/planner-progress.js';
import type { AgentEvent, Connector, Reply, TurnResult } from '../src/providers/types.js';

const message: Reply = { kind: 'message', text: 'hello', questions: [], findings: [] };
const completed: TurnResult = { status: 'completed', reply: message, usage: null, error: null };

function fixture(t: { after(fn: () => void): void }, overrides: { interval?: number; bytes?: number } = {}) {
  const previous = currentSettings();
  useSettings({
    ...defaultSettings(),
    outputFlushIntervalMs: overrides.interval ?? 60_000,
    outputFlushBytes: overrides.bytes ?? 1024 * 1024,
  });
  const directory = mkdtempSync(join(tmpdir(), 'grampus-output-test-'));
  const store = new Store(join(directory, 'grampus.sqlite'));
  const sessions = new Sessions(store);
  const session = sessions.create('codex', directory);
  t.after(() => {
    useSettings(previous);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, sessions, session };
}

/** A connector whose turn emits `events` (string entries are deltas) and then completes. */
function connector(events: (string | AgentEvent)[], during?: () => Promise<void>): Connector {
  return async (_, options) => {
    options.emit({ type: 'session.connected', data: { providerSessionId: 'thread', model: 'fixture' } });
    return {
      turn: async () => {
        for (const event of events)
          options.emit(typeof event === 'string' ? { type: 'output.delta', data: { text: event } } : event);
        await during?.();
        return completed;
      },
      interrupt: async () => {},
      close: async () => {},
    };
  };
}

const kinds = (store: Store, id: string) =>
  store
    .sessionEvents(id)
    .filter(event => ['output.delta', 'context.updated', 'turn.result', 'turn.started'].includes(event.type))
    .map(event =>
      event.type === 'output.delta' ? `delta:${(event.data as { data: { text: string } }).data.text}` : event.type,
    );

test('deltas are coalesced and journaled before the next event and before settlement, in order', async t => {
  const { store, session } = fixture(t);
  const context: AgentEvent = { type: 'context.updated', data: { inputTokens: 12 } };
  const turn = { type: 'turn.started', data: { providerTurnId: null } };
  const result = await runSession(
    store,
    session.id,
    'Work',
    {},
    connector([turn, 'Hel', 'lo', ' wor', context, 'ld', '!']),
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(kinds(store, session.id), [
    'turn.started',
    'delta:Hello wor',
    'context.updated',
    'delta:ld!',
    'turn.result',
  ]);
});

test('a full buffer is journaled at once and a quiet one after the interval, without rewriting the session', async t => {
  const { store, session } = fixture(t, { interval: 100, bytes: 1024 });
  const saves: string[] = [];
  const saveSession = store.saveSession.bind(store);
  store.saveSession = (id, state) => {
    saves.push(state.phase);
    saveSession(id, state);
  };
  let observedBySize = 0,
    observedByTime = 0;
  const deltas = () => store.sessionEvents(session.id, ['output.delta']).length;
  const result = await runSession(
    store,
    session.id,
    'Work',
    {},
    connector(['x'.repeat(600), 'y'.repeat(600), 'tail'], async () => {
      observedBySize = deltas();
      const before = saves.length;
      await sleep(400);
      observedByTime = deltas();
      assert.equal(saves.length, before, 'delta-only flushes never rewrite the session record');
      const progress = plannerProgress(store.sessionEvents(session.id), store.session(session.id));
      assert.equal(progress?.stage, 'responding', 'live progress still sees the flushed output');
    }),
  );
  assert.equal(result.status, 'completed');
  assert.equal(observedBySize, 1, 'the 1 KiB limit flushed the first two chunks together');
  assert.equal(observedByTime, 2, 'the interval flushed the remaining text while the turn was still running');
  const texts = store
    .sessionEvents(session.id, ['output.delta'])
    .map(event => (event.data as { data: { text: string } }).data.text);
  assert.deepEqual(texts, ['x'.repeat(600) + 'y'.repeat(600), 'tail']);
});

test('buffered text of an interrupted run is journaled before its stop and its result', async t => {
  const { store, session } = fixture(t);
  const controller = new AbortController();
  const connect: Connector = async (_, options) => ({
    turn: () =>
      new Promise<TurnResult>(resolve => {
        options.emit({ type: 'output.delta', data: { text: 'partial' } });
        controller.signal.addEventListener('abort', () =>
          setTimeout(() => resolve({ status: 'interrupted', reply: null, usage: null, error: 'Stopped' }), 10),
        );
        setTimeout(() => controller.abort(), 20);
      }),
    interrupt: async () => {},
    close: async () => {},
  });
  const result = await runSession(store, session.id, 'Work', { signal: controller.signal }, connect);
  assert.equal(result.status, 'interrupted');
  const order = store
    .sessionEvents(session.id)
    .map(event => event.type)
    .filter(type => ['output.delta', 'stop.requested', 'turn.result'].includes(type));
  assert.deepEqual(order, ['output.delta', 'stop.requested', 'turn.result']);
});

test('text from a run that lost the session is ignored, never attributed to another run', async t => {
  const { store, sessions, session } = fixture(t);
  const claim = sessions.claim(session.id, 'Work');
  sessions.settle(session.id, claim.runId, completed, true);
  assert.equal(sessions.delta(session.id, claim.runId, 'late'), false);
  const last = store.sessionEvents(session.id).at(-1)!;
  assert.equal(last.type, 'event.ignored');
  assert.deepEqual(last.data, { runId: claim.runId, eventType: 'output.delta' });
});
