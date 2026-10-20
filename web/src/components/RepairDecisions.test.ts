// The task shows both approved allowances and observed repair results supplied by the controller.
import { afterEach, expect, it } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { mockTask } from '../mock';
import { render } from '../testing';
import RepairDecisions from './RepairDecisions.vue';

let mounted: VueWrapper | undefined;
afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
});

it('distinguishes readiness spending from behavioural repairs and shows what the next attempt established', async () => {
  const repairs = structuredClone(mockTask.repairs);
  repairs.readiness = { used: 1, allowance: 2, remaining: 1, checks: 2 };
  repairs.decisions[0]!.results = [
    { name: 'Formatting', outcome: 'passed', artifact: 'sha256:repaired' },
    { name: 'Browser expiry', outcome: 'failed', artifact: 'sha256:repaired' },
  ];
  repairs.decisions[0]!.outcome = 'The browser expiry check still fails.';
  mounted = await render(RepairDecisions, { repairs });
  expect(mounted.text()).toContain('Behavioural repairs: 1 of 3');
  expect(mounted.get('[data-readiness-budget]').text()).toContain('Readiness repairs: 1 of 2');
  expect(mounted.text()).toContain('Formatting: passed');
  expect(mounted.text()).toContain('Browser expiry: failed');
  expect(mounted.text()).toContain('The browser expiry check still fails.');
  expect(mounted.get('details').text()).toContain('sha256:repaired');
});
