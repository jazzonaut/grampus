// Exercises discovered model suggestions at the provider/model input seam.
import { expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ModelAssignmentEditor from './ModelAssignmentEditor.vue';

it('offers discovered models for the selected provider and preserves manual model entry', async () => {
  const wrapper = mount(ModelAssignmentEditor, {
    props: {
      label: 'Planning',
      modelValue: { provider: 'codex', model: null },
      efforts: { codex: ['low', 'high'], claude: ['low', 'high'] },
      models: {
        codex: { models: [{ id: 'codex-model', label: 'Codex model', efforts: ['high'] }], problem: null },
        claude: { models: [{ id: 'claude-model', label: 'Claude model', efforts: ['low'] }], problem: null },
      },
    },
  });
  try {
    expect(wrapper.get('input').attributes('list')).toBe(wrapper.get('datalist').attributes('id'));
    expect(wrapper.get('datalist option').attributes('value')).toBe('codex-model');
    await wrapper.get('input').setValue('custom-model');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ provider: 'codex', model: 'custom-model' });
    await wrapper.setProps({ modelValue: { provider: 'claude', model: null } });
    expect(wrapper.get('datalist option').attributes('value')).toBe('claude-model');
  } finally {
    wrapper.unmount();
  }
});
