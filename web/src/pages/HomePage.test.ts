import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import HomePage from './HomePage.vue';
import { emptyOverview, mockOverview } from '../mock';
import { fakeServer, posts, render } from '../testing';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HomePage', () => {
  it('puts the attention queue first, with reasons, and lists tasks, planning, deliveries and the pool', async () => {
    fakeServer({});
    const wrapper = await render(HomePage, { overview: mockOverview, refresh: vi.fn().mockResolvedValue(undefined) });
    const panels = wrapper.findAll('[data-panel]').map(panel => panel.attributes('data-panel'));
    expect(panels[0]).toBe('attention');
    const attention = wrapper.get('[data-panel="attention"]');
    expect(attention.text()).toContain("this slice's shared repair allowance is used up");
    expect(attention.text()).toContain('CHECK_REPAIR_EXHAUSTED');
    // An action with a form links to its screen instead of posting from here.
    expect(attention.get('[data-attention="question"] a[href="#/tasks/task-2"]').text()).toContain('Rename');
    expect(attention.text()).toContain('Open to send answers and continue');
    expect(wrapper.get('[data-pool]').text()).toBe('1 of 2 guided tasks running');
    expect(wrapper.findAll('[data-task]')).toHaveLength(2);
    expect(wrapper.get('[data-task="task-1"] [data-usage]').text()).toContain('Usage unknown');
    expect(wrapper.text()).toContain('Document the import format');
    expect(wrapper.text()).toContain('Fix date parsing in reports');
    expect(wrapper.text()).toContain('0123456789ab');
    expect(wrapper.text()).toContain('Integrations need attention');
  });

  it('sends an inline action exactly as offered and says it was requested', async () => {
    const sent = fakeServer({ 'POST /api/tasks/task-4/retry': { ok: true } });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const wrapper = await render(HomePage, { overview: mockOverview, refresh });
    await wrapper.get('[data-attention="failed_check"] [data-action="retry"] button').trigger('click');
    await flushPromises();
    expect(posts(sent)).toEqual([{ method: 'POST', path: '/api/tasks/task-4/retry', body: { expected: 'key-4' } }]);
    expect(refresh).toHaveBeenCalled();
    expect(wrapper.get('[data-notice="requested"]').text()).toContain('Retry repair: requested');
    // The button stays disabled until the server's state changes.
    expect(
      wrapper.get('[data-attention="failed_check"] [data-action="retry"] button').attributes('disabled'),
    ).toBeDefined();
    await wrapper.setProps({ overview: { ...mockOverview, revision: 'r2', attention: [] } });
    expect(wrapper.find('[data-notice="requested"]').exists()).toBe(false);
  });

  it('shows calm empty states without tasks', async () => {
    fakeServer({});
    const wrapper = await render(HomePage, { overview: emptyOverview, refresh: vi.fn() });
    expect(wrapper.text()).toContain('Nothing needs you right now.');
    expect(wrapper.text()).toContain('No tasks yet');
    expect(wrapper.text()).toContain('No planning conversations in progress.');
    expect(wrapper.text()).toContain('Nothing delivered yet.');
  });

  it('says it is loading before the first overview', async () => {
    fakeServer({});
    const wrapper = await render(HomePage, { overview: undefined, refresh: vi.fn() });
    expect(wrapper.get('[role="status"]').text()).toContain('Loading the overview');
  });
});
