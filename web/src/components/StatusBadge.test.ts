import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import icons from '@nuxt/ui/runtime/vue/plugins/icons.js';
import StatusBadge from './StatusBadge.vue';
import { statusPresentation, statuses } from '../theme/status';

describe('StatusBadge', () => {
  it.each(statuses)('shows a label and an icon for %s, never colour alone', status => {
    const wrapper = mount(StatusBadge, { props: { status }, global: { plugins: [icons] } });

    expect(wrapper.text()).toBe(statusPresentation[status].label);
    // The bundled icon renders as an inline SVG straight away, with no request.
    expect(wrapper.find('svg').exists()).toBe(true);
    expect(wrapper.attributes('data-status')).toBe(status);
  });

  it('keeps the status icon when the label is overridden', () => {
    const wrapper = mount(StatusBadge, {
      props: { status: 'awaiting_human', label: 'Needs your answer' },
      global: { plugins: [icons] },
    });

    expect(wrapper.text()).toBe('Needs your answer');
    expect(wrapper.find('svg').exists()).toBe(true);
  });

  it('gives every status a distinct label', () => {
    const labels = statuses.map(status => statusPresentation[status].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
