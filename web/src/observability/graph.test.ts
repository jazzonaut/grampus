// Replay must never borrow current status or usage from the future.
import { describe, expect, it } from 'vitest';
import type { ActivityNodeV1 } from '../../../src/server/api-types';
import { compactGraph, graphFrame, usageSnapshots } from './graph';
import { activityEvent as event } from '../testing';

const nodes: ActivityNodeV1[] = [
  { id: 'controller', kind: 'controller', label: 'Controller', detail: '', status: 'observed' },
  { id: 'agent:s', kind: 'agent', label: 'Implementer', detail: '', status: 'completed' },
  { id: 'tools:s', kind: 'tools', label: 'Tools', detail: '', status: 'completed' },
];
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

  it('keeps the unfinished tool label and connector active when another call completes', () => {
    const read = event('read', {
      source: 'agent:s',
      target: 'tools:s',
      label: 'Read file started',
      correlation: { ...event('base').correlation, itemId: 'read' },
      updates: [{ nodeId: 'tools:s', status: 'active' }],
    });
    const search = event('search', {
      ...read,
      id: 'search',
      label: 'Search files started',
      correlation: { ...read.correlation, itemId: 'search' },
    });
    const completed = event('read-done', {
      ...read,
      id: 'read-done',
      source: 'tools:s',
      target: 'agent:s',
      label: 'Read file completed',
      status: 'completed',
      updates: [{ nodeId: 'tools:s', status: 'completed' }],
    });
    const frame = graphFrame(nodes, [read, search, completed], true);
    expect(frame.nodes.find(node => node.id === 'tools:s')?.activity?.label).toBe('Search files started');
    expect(frame.edges.find(edge => edge.source === 'agent:s')?.event?.label).toBe('Search files started');
    expect(frame.edges.find(edge => edge.source === 'tools:s')?.active).toBe(false);
    const done = event('search-done', {
      ...completed,
      id: 'search-done',
      correlation: search.correlation,
    });
    expect(graphFrame(nodes, [read, search, completed, done], true).edges.some(edge => edge.active)).toBe(false);
  });

  it('does not animate a completed route merely because another route keeps the same node active', () => {
    const first = event('first', { correlation: { ...event('base').correlation, itemId: 'one' } });
    const done = event('done', {
      ...first,
      id: 'done',
      status: 'completed',
      updates: [{ nodeId: 'agent:s', status: 'completed' }],
    });
    const second = event('second', {
      source: 'tools:s',
      correlation: { ...first.correlation, itemId: 'two' },
    });
    const frame = graphFrame(nodes, [first, done, second], true);
    expect(frame.edges.find(edge => edge.source === 'controller')?.active).toBe(false);
    expect(frame.edges.find(edge => edge.source === 'tools:s')?.active).toBe(true);
  });

  it('retains the active session label when compact groups also contain completed sessions', () => {
    const frame = graphFrame(nodes, [event('running', { label: 'Inspect repository' })], true);
    const active = frame.nodes.find(node => node.kind === 'agent')!;
    active.groupId = 'implementers';
    frame.nodes.push({
      ...active,
      id: 'agent:old',
      status: 'completed',
      activity: event('old', { label: 'Old reply' }),
    });
    const grouped = compactGraph(frame);
    expect(grouped.nodes.find(node => node.id === 'implementers')?.activity?.label).toBe('Inspect repository');
  });
});
