// Headline updates preserve the difference between unknown measurements and a measured zero.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UsageHeadline from './UsageHeadline.vue';
import type { UsageHeadlineV1 } from '../../../src/server/api-types';

describe('UsageHeadline', () => {
  it('updates from unknown to live and final measurements without inventing cost', async () => {
    const usage: UsageHeadlineV1 = {
      tokens: null,
      cachedTokens: null,
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

  it('shows how many of the tokens were cache reads only when some were', () => {
    const usage: UsageHeadlineV1 = {
      tokens: 278_476,
      cachedTokens: 214_400,
      estimatedCostUsd: null,
      completeness: 'complete',
      turns: 1,
      interventions: 0,
    };
    const wrapper = mount(UsageHeadline, { props: { usage } });
    expect(wrapper.text()).toContain('278,476 tokens');
    expect(wrapper.text()).toContain('214,400 cached');
    wrapper.unmount();
    for (const cachedTokens of [0, null]) {
      const plain = mount(UsageHeadline, { props: { usage: { ...usage, cachedTokens } } });
      expect(plain.text()).not.toContain('cached');
      plain.unmount();
    }
  });
});
