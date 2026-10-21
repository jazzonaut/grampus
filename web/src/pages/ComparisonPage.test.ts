import { afterEach, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { ComparisonV1, ModelProfileV1, RunMetricsV1 } from '../../../src/server/api-types';
import ComparisonPage from './ComparisonPage.vue';
import { mockAction, mockPlan, mockUsage } from '../mock';
import { fakeServer, posts, render, status } from '../testing';

let mounted: VueWrapper | undefined;
afterEach(() => mounted?.unmount());

it('selects a preferred run with the exact server request and leaves integration as a separate action', async () => {
  const profile: ModelProfileV1 = {
    id: 'economy',
    name: 'Economy',
    planning: { provider: 'codex', model: null },
    implementation: { provider: 'codex', model: 'writer' },
    review: { provider: 'claude', model: 'reviewer' },
  };
  const metrics: RunMetricsV1 = {
    executionPhases: [],
    taskId: 'task-one',
    title: 'Change',
    status: 'complete',
    verifiedDelivery: true,
    profile,
    startedAt: null,
    completedAt: null,
    elapsedMs: null,
    agentMs: null,
    agentTimePartial: true,
    checkMs: null,
    checkTimePartial: true,
    workflowActiveMs: null,
    waitingMs: null,
    timingAsOf: null,
    timingPartial: true,
    firstAttemptDelivery: true,
    repairAttempts: 0,
    interventions: mockUsage.interventions,
    usage: mockUsage,
    models: [],
    subscription: { observations: 0, rejectedTurns: null, allowanceConsumed: null },
    subscriptionAllowanceConsumed: null,
    billedCostUsd: null,
    notes: [],
  };
  const select = mockAction('comparison-select', 'Select this result', {
    path: '/api/comparisons/group/select',
    expected: 'comparison-key',
    body: { expected: 'comparison-key', taskId: 'task-one' },
  });
  const group: ComparisonV1 = {
    apiVersion: 1,
    id: 'group',
    name: 'Compare profiles',
    status: 'complete',
    note: 'Runs settled',
    digest: 'digest',
    expected: 'comparison-key',
    approved: true,
    cursor: 1,
    plan: mockPlan,
    runs: [
      {
        taskId: 'task-one',
        version: 1,
        digest: 'one',
        profile,
        metrics,
        matchesApprovedConfiguration: true,
        preferred: false,
        assignments: [],
        select,
      },
    ],
    preferredTaskId: null,
    integration: null,
    sharedPlanning: null,
    actions: [],
    exports: { json: '/export', csv: '/export?format=csv', compressed: '/export?format=gzip' },
    notes: [],
  };
  const sent = fakeServer({
    '/api/v1/comparisons/group': group,
    'POST /api/comparisons/group/select': status(200, {}),
  });
  mounted = await render(ComparisonPage, { id: 'group' });
  expect(mounted.text()).toContain('Economy');
  await mounted.get('[data-action="comparison-select"] button').trigger('click');
  await flushPromises();
  expect(posts(sent)).toEqual([{ method: 'POST', path: select.request.path, body: select.request.body }]);
  expect(mounted.find('[data-action="comparison-integrate"]').exists()).toBe(false);
});
