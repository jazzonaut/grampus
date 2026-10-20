// Checks that a fixed profile replaces the provider defaults choice in the kickoff form and request.
import { afterEach, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { ModelProfilesV1 } from '../../../src/server/api-types';
import NewTaskPage from './NewTaskPage.vue';
import { mockKickoff } from '../mock';
import { fakeServer, posts, render } from '../testing';

const catalogue: ModelProfilesV1 = {
  profiles: [
    {
      id: 'mixed',
      name: 'Mixed providers',
      planning: { provider: 'claude', model: 'planner', effort: 'high' },
      implementation: { provider: 'codex', model: 'writer', effort: 'low' },
      review: { provider: 'claude', model: 'reviewer', effort: 'high' },
    },
  ],
  expected: 'catalogue',
  editable: true,
  problem: null,
  qualityPasses: [],
  efforts: { codex: ['low', 'high'], claude: ['high'] },
};

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  window.location.hash = '';
});

it('hides the provider choice for a profile and restores the previous choice for defaults', async () => {
  const sent = fakeServer({
    '/api/v1/model-profiles': catalogue,
    'POST /api/kickoffs': { id: 'k-new' },
    '/api/v1/kickoffs/k-new': { ...mockKickoff, actions: [] },
  });
  wrapper = await render(NewTaskPage);
  await wrapper.get('#new-repo').setValue('D:\\Projects\\exporter');
  await wrapper.get('#new-request').setValue('Retry exports');
  await wrapper.get('#new-provider').setValue('claude');
  const picker = wrapper.getComponent({ name: 'ModelProfilePicker' }).get('select');
  await picker.setValue('mixed');
  expect(wrapper.find('#new-provider').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Planner and implementer');
  expect(wrapper.find('#new-adapter').exists()).toBe(true);
  await picker.setValue('');
  expect((wrapper.get('#new-provider').element as HTMLSelectElement).value).toBe('claude');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(posts(sent)[0]?.body).toEqual({
    repo: 'D:\\Projects\\exporter',
    request: 'Retry exports',
    provider: 'claude',
    adapter: 'git',
  });
});

it('sends the selected profile without a conflicting provider default', async () => {
  const sent = fakeServer({
    '/api/v1/model-profiles': catalogue,
    'POST /api/kickoffs': { id: 'k-new' },
    '/api/v1/kickoffs/k-new': { ...mockKickoff, actions: [] },
  });
  wrapper = await render(NewTaskPage);
  await wrapper.get('#new-repo').setValue('D:\\Projects\\exporter');
  await wrapper.get('#new-request').setValue('Retry exports');
  await wrapper.getComponent({ name: 'ModelProfilePicker' }).get('select').setValue('mixed');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(posts(sent)[0]?.body).toEqual({
    repo: 'D:\\Projects\\exporter',
    request: 'Retry exports',
    modelProfile: catalogue.profiles[0],
    adapter: 'git',
  });
});
