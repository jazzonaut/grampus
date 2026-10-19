// Headline updates preserve the difference between unknown measurements and a measured zero.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UsageHeadline from './UsageHeadline.vue';
import type { UsageHeadlineV1 } from '../../../src/server/api-types';

describe('UsageHeadline', () => {
  it('updates from unknown to live and final measurements without inventing cost', async () => {
    const usage: UsageHeadlineV1 = {
      tokens: null,
      estimatedCostUsd: null,
      completeness: 'none',
      turns: 0,
      interventions: 0,
    };
    const wrapper = mount(UsageHeadline, { props: { usage } });
    expect(wrapper.text()).toContain('Usage unknown');
    expect(wrapper.text()).not.toContain('$');
    await wrapper.setProps({ usage: { ...usage, tokens: 1200, completeness: 'live', turns: 1 } });
    expect(wrapper.text()).toContain('1,200 tokens');
    expect(wrapper.text()).toContain('Live, may increase');
    await wrapper.setProps({ usage: { ...usage, tokens: 1500, completeness: 'complete', turns: 1 } });
    expect(wrapper.text()).toContain('1,500 tokens');
    expect(wrapper.text()).not.toContain('Live');
    await wrapper.setProps({ usage: { ...usage, tokens: 0, completeness: 'complete', turns: 1 } });
    expect(wrapper.text()).toContain('0 tokens');
    wrapper.unmount();
  });
});
