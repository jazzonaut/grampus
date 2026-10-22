import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { standardRecipe } from '../src/domain/recipe.js';
import type { StoredEvent, TaskEvent } from '../src/domain/events.js';
import { buildScorecard, renderScorecard } from '../src/measure/report.js';
import { measureDispatches } from '../src/measure/usage.js';
import { providerSessions } from '../src/orca/client.js';
import { foldEvents } from '../src/pipeline/state.js';
import {
  findClaudeTranscript,
  findCodexTranscript,
  readClaudeTranscript,
  readCodexTranscript,
} from '../src/measure/transcripts.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, seconds)).toISOString();
const ms = (seconds: number) => Date.parse(at(seconds));
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function claudeLine(seconds: number, id: string, usage: Record<string, unknown> | null) {
  return {
    type: 'assistant',
    timestamp: at(seconds),
    message: { id, model: 'claude-opus-5-5', ...(usage ? { usage } : {}) },
  };
}

test('Claude usage counts each message once and only inside the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grampus-claude-'));
  const project = join(dir, 'C--repo');
  mkdirSync(project);
  const usage = {
    input_tokens: 2,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 10,
    output_tokens: 7,
    output_tokens_details: { thinking_tokens: 3 },
  };
  writeFileSync(
    join(project, 'session-1.jsonl'),
    jsonl([
      { type: 'user', timestamp: at(1) },
      claudeLine(2, 'msg_a', usage),
      claudeLine(2, 'msg_a', usage), // a second content block of the same message
      claudeLine(3, 'msg_b', usage),
      claudeLine(20, 'msg_c', usage), // after the window: the next dispatch's turn
      'not json',
    ]),
  );
  const path = findClaudeTranscript('session-1', [join(dir, 'missing'), dir]);
  assert.equal(path, join(project, 'session-1.jsonl'));
  const reading = readClaudeTranscript(path ?? '', { from: ms(1), to: ms(10) });
  assert.deepEqual(reading.models, ['claude-opus-5-5']);
  assert.deepEqual(reading.usage, { input: 4, cachedInput: 200, cacheWrite: 20, output: 14, reasoning: 6 });
  assert.equal(readClaudeTranscript(path ?? '', { from: ms(30), to: ms(40) }).usage, null, 'no turns means unknown');
});

test('Codex usage is the growth of the cumulative total, with cache reads taken out of input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grampus-codex-'));
  const day = join(dir, '2026', '10', '22');
  mkdirSync(day, { recursive: true });
  const total = (input: number, cached: number, output: number) => ({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 1,
        },
      },
    },
  });
  writeFileSync(
    join(day, 'rollout-2026-10-22T10-00-00-session-9.jsonl'),
    jsonl([
      { ...total(100, 60, 10), timestamp: at(1) },
      { type: 'turn_context', timestamp: at(6), payload: { model: 'gpt-6.1-sol', effort: 'high' } },
      { ...total(250, 160, 30), timestamp: at(7) },
      { ...total(400, 300, 50), timestamp: at(9) },
      { ...total(900, 800, 90), timestamp: at(30) },
    ]),
  );
  const path = findCodexTranscript('session-9', [dir], new Date(ms(0)));
  assert.ok(path);
  const reading = readCodexTranscript(path ?? '', { from: ms(5), to: ms(10) });
  assert.deepEqual(reading.models, ['gpt-6.1-sol']);
  assert.equal(reading.effort, 'high');
  assert.deepEqual(reading.usage, { input: 60, cachedInput: 240, cacheWrite: 0, output: 40, reasoning: 0 });
});

test('provider sessions are read from Orca transcript message ids', () => {
  const ids = [
    'orca:1792624558767-5bf',
    'claude:2109e6da-41e4:a3fc5265',
    'orca:claude-tool%3A2109e6da-41e4%3Atoolu_01',
    'claude:2109e6da-41e4:07156f5b',
    'codex:01a160c0-a95f:01a160c0-af84:1',
  ];
  assert.deepEqual(providerSessions(ids.map(id => ({ id }))), ['2109e6da-41e4', '01a160c0-a95f']);
});

/** A task log with one spec dispatch that asked two questions, open at the same time, and then settled. */
function overlappingQuestions(): StoredEvent[] {
  const events: TaskEvent[] = [
    { type: 'log.header', schema: 1 },
    { type: 'task.created', taskId: 't', title: 'T', request: 'R', repoPath: '/r', recipe: standardRecipe },
    { type: 'stage.created', key: 'spec:1', stage: 'spec', round: 1, orcaTaskId: 'task_1' },
    { type: 'stage.started', key: 'spec:1', dispatchId: 'd1', assignment: null, reusedHandle: null, launch: null },
    { type: 'worker.message', messageId: 'q1', key: 'spec:1', kind: 'question', subject: 'Q', body: 'One?' },
    { type: 'worker.message', messageId: 'q2', key: 'spec:1', kind: 'question', subject: 'Q', body: 'Two?' },
    {
      type: 'command.applied',
      command: { id: 'c1', at: at(100), source: 'cli', kind: 'reply', messageId: 'q1', body: 'A' },
    },
    {
      type: 'command.applied',
      command: { id: 'c2', at: at(110), source: 'cli', kind: 'reply', messageId: 'q2', body: 'B' },
    },
    {
      type: 'stage.settled',
      key: 'spec:1',
      dispatchId: 'd1',
      messageId: 'm',
      outcome: 'succeeded',
      subject: 'S',
      body: 'B',
    },
  ];
  const times = [0, 0, 0, 0, 10, 20, 100, 110, 120];
  return events.map((event, index): StoredEvent => ({ ...event, at: at(times[index] ?? 0) }));
}

test('time spent waiting on questions open at the same time counts once', async () => {
  const state = foldEvents(overlappingQuestions());
  const orca = { transcriptSessions: () => Promise.resolve({ provider: null, sessionIds: [] }) };
  const [spec] = await measureDispatches(state, orca);
  assert.equal(spec?.durationMs, 120_000);
  assert.equal(spec?.waitingMs, 100_000, 'from the first question at 10s to the last answer at 110s');
  assert.equal(spec?.agentMs, 20_000);
});

test('a running task reports its wall time so far', () => {
  const events = overlappingQuestions();
  const state = foldEvents(events);
  const card = buildScorecard(state, events, [], {}, ms(300));
  assert.equal(card.wallMs, 300_000);
  assert.match(renderScorecard(card), /wall time 300s so far/);
});
