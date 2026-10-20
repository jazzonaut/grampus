// Replay must never borrow current status or usage from the future.
import { describe, expect, it } from 'vitest';
import type { ActivityEventV1, ActivityNodeV1 } from '../../../src/server/api-types';
import { graphFrame, usageSnapshots } from './graph';

const nodes: ActivityNodeV1[] = [
  { id: 'controller', kind: 'controller', label: 'Controller', detail: '', status: 'observed' },
  { id: 'agent:s', kind: 'agent', label: 'Implementer', detail: '', status: 'completed' },
  { id: 'tools:s', kind: 'tools', label: 'Tools', detail: '', status: 'completed' },
];
const event = (id: string, changes: Partial<ActivityEventV1> = {}): ActivityEventV1 => ({
  id,
  cursor: id,
  at: '2026-10-20T10:00:00.000Z',
  type: 'turn.requested',
  category: 'controller',
  source: 'controller',
  target: 'agent:s',
  label: 'Requested',
  status: 'active',
  provenance: 'observed',
  preview: null,
  durationMs: null,
  correlation: {
    taskId: 'task',
    version: 1,
    executionId: 'execution',
    sessionId: 's',
    runId: 'r',
    providerTurnId: null,
    itemId: null,
    resultId: null,
    attemptId: null,
    workspaceId: null,
    sliceIndex: null,
    artifact: null,
    messageId: null,
    requestId: null,
    parentItemId: null,
    providerSessionId: null,
    provider: null,
  },
  updates: [{ nodeId: 'agent:s', status: 'active' }],
  usage: null,
  ...changes,
});

describe('graph replay', () => {
  it('shows only participants introduced by the replay prefix, without later successful outcomes', () => {
    const frame = graphFrame(nodes, [event('start')], false);
    expect(frame.nodes.find(node => node.id === 'agent:s')?.status).toBe('active');
    expect(frame.nodes.some(node => node.id === 'tools:s')).toBe(false);
    expect(graphFrame(nodes, [], false).nodes).toEqual([]);
  });

  it('retains completed participants in the live network', () => {
    const frame = graphFrame(
      nodes,
      [event('end', { status: 'completed', updates: [{ nodeId: 'agent:s', status: 'completed' }] })],
      true,
    );
    expect(frame.nodes.find(node => node.id === 'agent:s')?.status).toBe('completed');
  });

  it('keeps a grouped tool active while another correlated call is unfinished', () => {
    const a = event('a', {
      target: 'tools:s',
      correlation: { ...event('base').correlation, itemId: 'a' },
      updates: [{ nodeId: 'tools:s', status: 'active' }],
    });
    const b = event('b', { ...a, id: 'b', correlation: { ...a.correlation, itemId: 'b' } });
    const completedA = event('done', { ...a, id: 'done', updates: [{ nodeId: 'tools:s', status: 'completed' }] });
    expect(graphFrame(nodes, [a, b, completedA], false).nodes.find(node => node.id === 'tools:s')?.status).toBe(
      'active',
    );
  });

  it('replaces cumulative usage snapshots without double counting', () => {
    const old = event('old', { usage: { input: 100, output: 10, cached: 20, scope: 'provider-session-cumulative' } });
    const latest = event('new', {
      usage: { input: 140, output: null, cached: 20, scope: 'provider-session-cumulative' },
    });
    expect(usageSnapshots([old, latest])).toEqual([latest.usage]);
  });
});
