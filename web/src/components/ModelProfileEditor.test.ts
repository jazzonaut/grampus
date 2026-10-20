import { afterEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ModelProfileEditor from './ModelProfileEditor.vue';
import type { ModelProfileV1, ModelProfilesV1 } from '../../../src/server/api-types';

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());
it('saves independent fixed role choices without changing the original profile', async () => {
  const profile: ModelProfileV1 = {
    id: 'balanced',
    name: 'Balanced',
    planning: { provider: 'codex', model: 'planner' },
    implementation: { provider: 'codex', model: 'writer' },
    review: { provider: 'claude', model: 'reviewer' },
  };
  const catalogue: ModelProfilesV1 = {
    profiles: [profile],
    expected: 'saved',
    editable: true,
    problem: null,
    qualityPasses: [],
    efforts: { codex: ['low', 'high'], claude: ['low', 'high'] },
  };
  wrapper = mount(ModelProfileEditor, { props: { profile, catalogue } });
  const implementation = wrapper.findAll('fieldset').find(item => item.find('legend').text() === 'Implementation')!;
  await implementation.find('input').setValue('economy');
  await implementation.findAll('select')[1]!.setValue('low');
  await wrapper.find('form').trigger('submit');
  const saved = wrapper.emitted('save')?.[0]?.[0] as ModelProfileV1;
  expect(saved.implementation).toEqual({ provider: 'codex', model: 'economy', effort: 'low' });
  expect(saved.review).toEqual(profile.review);
  expect(profile.implementation.model).toBe('writer');
});
