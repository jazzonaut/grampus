// Verifies live observations refresh without actions and retain an explicit stale warning on failure.
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { LiveChangesV1 } from '../../../src/server/api-types';
import LiveChanges from './LiveChanges.vue';
import { fakeServer, posts, render, status } from '../testing';

let mounted: VueWrapper | undefined;
afterEach(() => {
  mounted?.unmount();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const path = '/api/v1/tasks/task/live-changes';
const initial: LiveChangesV1 = {
  apiVersion: 1,
  observedAt: '2026-10-19T12:00:00Z',
  base: 'abc123',
  paths: ['src/export.ts'],
  total: 1,
  truncated: false,
  selected: null,
};

it('polls the selected diff, clears a reverted file and sends no actions', async () => {
  vi.useFakeTimers();
  let value: LiveChangesV1 = { ...initial, selected: { path: 'src/export.ts', patch: '-old\n+new', truncated: false } };
  const sent = fakeServer({ [path]: initial, [`${path}?path=src%2Fexport.ts`]: () => value });
  mounted = await render(LiveChanges, { path, intervalMs: 5000 });
  expect(mounted.text()).toContain('have not been verified');
  await mounted.get('[aria-label="Files changed since the task base"] button').trigger('click');
  await flushPromises();
  expect(mounted.get('pre').text()).toContain('+new');
  value = { ...value, selected: { path: 'src/export.ts', patch: '+updated', truncated: true } };
  await vi.advanceTimersByTimeAsync(5000);
  await flushPromises();
  expect(mounted.get('pre').text()).toContain('+updated');
  expect(mounted.text()).toContain('Diff preview truncated');
  value = { ...value, paths: [], total: 0, selected: null };
  await vi.advanceTimersByTimeAsync(5000);
  await flushPromises();
  expect(mounted.find('pre').exists()).toBe(false);
  expect(mounted.text()).toContain('No changed files observed');
  expect(posts(sent)).toEqual([]);
});

it('labels retained observations as stale when a later read fails', async () => {
  let failed = false;
  fakeServer({ [path]: () => (failed ? status(503, { error: { message: 'Workspace unavailable' } }) : initial) });
  mounted = await render(LiveChanges, { path, intervalMs: 5000 });
  failed = true;
  await mounted.get('button').trigger('click');
  await flushPromises();
  expect(mounted.get('[role="alert"]').text()).toContain('last successful read');
  expect(mounted.text()).toContain('src/export.ts');
  expect(mounted.text()).not.toContain('No changed files observed');
});
