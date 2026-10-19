// Workspace navigation remains keyboard accessible and names the displayed panel.
import { afterEach, describe, expect, it } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { render } from '../testing';
import ViewTabs from './ViewTabs.vue';

let wrapper: VueWrapper;
afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = '';
});

describe('ViewTabs', () => {
  it('moves focus and selection with arrows, Home and End, wrapping at either end', async () => {
    wrapper = await render(ViewTabs, {
      modelValue: 'results',
      label: 'Task views',
      items: [
        { id: 'results', label: 'Results' },
        { id: 'plan', label: 'Plan' },
        { id: 'usage', label: 'Usage' },
      ],
      'onUpdate:modelValue': (value: string) => {
        void wrapper.setProps({ modelValue: value });
      },
    });
    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[0]!.trigger('keydown', { key: 'ArrowLeft' });
    expect(tabs[2]!.attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[2]!.element);
    await tabs[2]!.trigger('keydown', { key: 'ArrowRight' });
    expect(tabs[0]!.attributes('tabindex')).toBe('0');
    await tabs[0]!.trigger('keydown', { key: 'End' });
    expect(tabs[2]!.attributes('aria-selected')).toBe('true');
    await tabs[2]!.trigger('keydown', { key: 'Home' });
    expect(tabs[0]!.attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(tabs[0]!.attributes('id'));
    expect(tabs[0]!.attributes('aria-controls')).toBe(wrapper.get('[role="tabpanel"]').attributes('id'));
  });
});
