// Pins metadata capture without retaining prompts, arguments, results or hidden reasoning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeActivity, codexActivity } from '../src/providers/activity.js';
import type { AgentEvent } from '../src/providers/types.js';

test('Codex item telemetry retains correlation and reported duration, never payloads', () => {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => events.push(event);
  codexActivity(
    'item/started',
    {
      turnId: 't',
      item: { type: 'mcpToolCall', id: 'call', tool: 'search', server: 'docs', arguments: { secret: 'do not retain' } },
    },
    emit,
  );
  codexActivity(
    'item/completed',
    {
      turnId: 't',
      item: {
        type: 'mcpToolCall',
        id: 'call',
        tool: 'search',
        status: 'failed',
        durationMs: 23,
        result: 'private result',
      },
    },
    emit,
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    type: 'activity.completed',
    data: {
      id: 'call',
      providerTurnId: 't',
      kind: 'tool',
      name: 'search',
      server: null,
      status: 'failed',
      durationMs: 23,
    },
  });
  assert.doesNotMatch(JSON.stringify(events), /private|do not retain|arguments/);
  codexActivity('item/completed', { item: { id: 7, type: 'fileChange' } }, emit);
  codexActivity('item/completed', { item: { id: 'reasoning', type: 'reasoning', content: 'hidden' } }, emit);
  assert.equal(events.length, 2);
});

test('Claude distinguishes generated tool requests from execution progress and failed results', () => {
  const events: AgentEvent[] = [];
  const capture = new ClaudeActivity(event => events.push(event));
  capture.message('assistant', {
    message: { id: 'msg', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { password: 'private' } }] },
    request_id: 'req',
    parent_tool_use_id: null,
  });
  capture.message('tool_progress', { tool_use_id: 'call', tool_name: 'Read', elapsed_time_seconds: 2 });
  capture.message('user', {
    message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: true, content: 'secret output' }] },
  });
  assert.deepEqual(
    events.map(event => event.type),
    ['activity.requested', 'activity.progress', 'activity.completed'],
  );
  assert.deepEqual(events[2]?.data, { id: 'call', kind: 'tool', status: 'failed' });
  assert.doesNotMatch(JSON.stringify(events), /private|secret output|password/);
});

test('Claude response boundaries retain message identity without treating a tool-input block stop as execution completion', () => {
  const events: AgentEvent[] = [];
  const capture = new ClaudeActivity(event => events.push(event));
  capture.message('stream_event', { event: { type: 'message_start', message: { id: 'm', model: 'actual-model' } } });
  capture.message('stream_event', { event: { type: 'content_block_stop', index: 0 } });
  assert.equal(events.length, 1);
  capture.message('stream_event', { event: { type: 'message_stop' } });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1]?.data, { id: 'm', kind: 'model', status: 'completed' });
});
