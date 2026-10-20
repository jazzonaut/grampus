// Checks that model discovery feeds every role without becoming a periodic provider probe.
import { afterEach, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import ModelProfilesPage from './ModelProfilesPage.vue';
import { fakeServer, render } from '../testing';

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

it('loads model suggestions once and offers them when creating a profile', async () => {
  const requests = fakeServer({
    '/api/v1/model-profiles': {
      profiles: [],
      expected: 'absent',
      editable: true,
      problem: null,
      qualityPasses: [],
      efforts: { codex: ['high'], claude: ['high'] },
    },
    '/api/v1/provider-models': {
      codex: { models: [{ id: 'coder', label: 'Coder', efforts: ['high'] }], problem: null },
      claude: { models: [{ id: 'reviewer', label: 'Reviewer', efforts: ['high'] }], problem: null },
    },
  });
  wrapper = await render(ModelProfilesPage);
  const create = wrapper.findAll('button').find(button => button.text() === 'Create profile')!;
  await create.trigger('click');
  await flushPromises();
  expect(wrapper.findAll('datalist option').map(option => option.attributes('value'))).toEqual([
    'coder',
    'coder',
    'reviewer',
  ]);
  expect(requests.filter(request => request.path === '/api/v1/provider-models')).toHaveLength(1);
  expect(wrapper.findAll('datalist').map(list => list.attributes('id'))).toEqual(
    expect.arrayContaining([wrapper.findAll('input[list]')[0]!.attributes('list')]),
  );
});
