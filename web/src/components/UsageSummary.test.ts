import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UsageSummary from './UsageSummary.vue';
import type { UsageRow } from './types';

const unmeasured: UsageRow = {
  id: 'claude',
  label: 'Claude',
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  estimatedCostUsd: null,
  partial: [],
};

function cells(wrapper: ReturnType<typeof mount>, metric: string): string[] {
  return wrapper.findAll(`td[data-metric="${metric}"]`).map(cell => cell.text());
}

describe('UsageSummary', () => {
  it('shows unknown measurements as Unknown, never as 0', () => {
    const wrapper = mount(UsageSummary, { props: { providers: [unmeasured] } });

    for (const metric of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'estimatedCostUsd']) {
      const [text] = cells(wrapper, metric);
      expect(text).toBe('Unknown');
      expect(text).not.toMatch(/\d/);
    }
    expect(wrapper.text()).not.toMatch(/\$0|\b0\b/);
  });

  it('keeps a measured zero distinct from unknown', () => {
    const wrapper = mount(UsageSummary, {
      props: { providers: [{ ...unmeasured, inputTokens: 0, estimatedCostUsd: 0 }] },
    });

    expect(cells(wrapper, 'inputTokens')).toEqual(['0']);
    expect(cells(wrapper, 'estimatedCostUsd')).toEqual(['$0.00']);
    expect(cells(wrapper, 'outputTokens')).toEqual(['Unknown']);
  });

  it('marks partial values as lower bounds', () => {
    const wrapper = mount(UsageSummary, {
      props: {
        providers: [],
        stages: [{ ...unmeasured, id: 'review', label: 'Review', inputTokens: 1200, partial: ['inputTokens'] }],
      },
    });

    const [input] = cells(wrapper, 'inputTokens');
    expect(input).toContain('1,200');
    expect(input).toContain('partial');
    expect(input).toContain('a lower bound');
    expect(wrapper.text()).toContain('billed cost is unknown');
  });
});
