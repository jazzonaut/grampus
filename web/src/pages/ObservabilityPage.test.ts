// Both owners use the same page, polling, history merge and replay controls.
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { ActivityEventV1, ActivitySubjectV1, ObservabilityV1 } from '../../../src/server/api-types';
import ObservabilityPage from './ObservabilityPage.vue';
import { fakeServer, posts, render, status } from '../testing';

let mounted: VueWrapper | undefined;
afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
});

function event(sequence: number): ActivityEventV1 {
  return {
    id: `session:${sequence}`,
    cursor: `cursor-${sequence}`,
    at: '2026-10-20T10:00:00.000Z',
    type: 'turn.requested',
    category: 'controller',
    source: 'controller',
    target: 'agent:planner',
    label: `Planning turn ${sequence}`,
    status: 'active',
    provenance: 'observed',
    preview: null,
    durationMs: null,
    correlation: {
      taskId: null,
      version: null,
      executionId: null,
      sessionId: 'planner',
      runId: `run-${sequence}`,
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
      provider: 'codex',
    },
    updates: [{ nodeId: 'agent:planner', status: 'active' }],
    usage: null,
  };
}

function window(subject: ActivitySubjectV1): ObservabilityV1 {
  return {
    apiVersion: 1,
    subject,
    revision: '1',
    intervalMs: 1000,
    nodes: [
      { id: 'controller', kind: 'controller', label: 'Grampus', detail: '', status: 'observed' },
      { id: 'agent:planner', kind: 'agent', label: 'Codex planner', detail: 'planning', status: 'active' },
    ],
    events: [event(2)],
    before: 'cursor-2',
    coverage: ['Missing telemetry remains unknown.'],
  };
}

describe('ObservabilityPage', () => {
  it.each(['task', 'planning'] as const)('keeps %s history deduplicated and replays without writes', async kind => {
    const subject = { kind, id: 'owner' };
    const path = `/api/v1/${kind === 'task' ? 'tasks' : 'kickoffs'}/owner/observability`;
    const view = window(subject);
    const sent = fakeServer({
      [path]: view,
      [`${path}?before=cursor-2`]: { ...view, events: [event(1), event(2)], before: null },
    });
    mounted = await render(ObservabilityPage, subject);
    expect(mounted.get(`a[href="#/${kind === 'task' ? 'tasks' : 'planning'}/owner"]`).text()).toContain(
      `Back to ${kind}`,
    );
    expect(mounted.get('caption').text()).toContain('1 matching events');
    const click = async (label: string) => {
      await mounted!
        .findAll('button')
        .find(button => button.text() === label)!
        .trigger('click');
      await flushPromises();
    };
    await click('Load earlier events');
    expect(sent.some(request => request.path === `${path}?before=cursor-2`)).toBe(true);
    expect(mounted.get('caption').text()).toContain('2 matching events');
    expect(mounted.text()).toContain('Historical replay');
    await click('Previous event');
    expect(mounted.get('caption').text()).toContain('1 matching events');
    expect(mounted.get('tbody').text()).toContain('Planning turn 1');
    expect(mounted.get('tbody').text()).not.toContain('Planning turn 2');
    await click('Next event');
    expect(mounted.get('caption').text()).toContain('2 matching events');
    await click('Return to live');
    expect(mounted.get('caption').text()).toContain('2 matching events');
    expect(posts(sent)).toEqual([]);
  });

  it('shows a failed planning activity read explicitly', async () => {
    fakeServer({ '/api/v1/kickoffs/missing/observability': status(404, { error: { message: 'Not available' } }) });
    mounted = await render(ObservabilityPage, { kind: 'planning', id: 'missing' });
    expect(mounted.get('[role="alert"]').text()).toContain('Activity unavailable: Not available');
    expect(mounted.get('caption').text()).toContain('0 matching events');
  });
});
