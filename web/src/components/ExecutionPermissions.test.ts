// Approval must expose directory permissions and restore assumptions before a user authorises work.
import { expect, it } from 'vitest';
import ScopeReview from './ScopeReview.vue';
import CommandDetails from './CommandDetails.vue';
import { render } from '../testing';
import PlanCard from './PlanCard.vue';
import { mockPlan } from '../mock';

it('includes directory grants in the initial plan file-permissions section', async () => {
  const plan = structuredClone(mockPlan);
  plan.slices[0]!.directories = [{ path: 'src/new-feature', actions: ['edit', 'create'], suffixes: ['.ts'] }];
  const wrapper = await render(PlanCard, { plan });
  const permissions = wrapper
    .findAll('details')
    .find(details => details.find('summary').text() === 'File permissions and repository access');
  expect(permissions?.text()).toContain('src/new-feature');
  expect(permissions?.text()).toContain('create');
  wrapper.unmount();
});

it('shows the slice-wide diagnostic attempt budget before plan approval', async () => {
  const plan = structuredClone(mockPlan);
  plan.slices[0]!.diagnostics = [
    { name: 'Browser', file: 'node', args: ['browser.js'], timeoutMs: 30000, maxRuns: 3, selection: '{}' },
  ];
  const wrapper = await render(PlanCard, { plan });
  expect(wrapper.text()).toContain('3 diagnostic attempts per slice across all selections and repairs');
  wrapper.unmount();
});

it('shows directory grants without describing a directory-only scope as changing no files', async () => {
  const wrapper = await render(ScopeReview, {
    scope: {
      files: [],
      instructions: [],
      error: null,
      directories: [{ path: 'src/feature', actions: ['edit', 'create'], suffixes: ['.ts'] }],
    },
  });
  expect(wrapper.text()).toContain('src/feature');
  expect(wrapper.text()).toContain('create');
  expect(wrapper.text()).toContain('.ts');
  expect(wrapper.text()).not.toContain('This slice changes no files');
  wrapper.unmount();
});

it('shows complete restore inputs and managed outputs alongside the exact command', async () => {
  const wrapper = await render(CommandDetails, {
    command: {
      file: 'node',
      args: ['install.cjs'],
      restore: { inputs: ['package-lock.json', 'patches'], outputs: ['node_modules'] },
    },
  });
  expect(wrapper.text()).toContain('package-lock.json');
  expect(wrapper.text()).toContain('patches');
  expect(wrapper.text()).toContain('node_modules');
  expect(wrapper.text()).toContain('install.cjs');
  wrapper.unmount();
});
