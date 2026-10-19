import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import HealthPage from './HealthPage.vue';
import { emptyOverview, mockOverview } from '../mock';
import { fakeServer, render, status } from '../testing';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HealthPage', () => {
  it('lists each integration with version and capability statuses in words, and the warnings', async () => {
    fakeServer({});
    const wrapper = await render(HealthPage, { overview: mockOverview, refresh: vi.fn() });
    expect(wrapper.get('[data-overall]').text()).toBe('Integrations need attention');
    const codex = wrapper.get('[data-integration="codex"]');
    expect(codex.text()).toContain('0.163.0');
    expect(codex.get('[data-capability="inference"]').text()).toContain('Not tested');
    expect(wrapper.get('[data-integration="claude"]').text()).toContain('SDK 0.3.302');
    expect(wrapper.text()).toContain('Codex changed from 0.162.0 to 0.163.0');
    expect(wrapper.get('[data-checked]').text()).toContain('Checked');
  });

  it('checks again through the health route and then rereads the overview', async () => {
    const sent = fakeServer({ '/api/health?refresh=1': { status: 'healthy' } });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const wrapper = await render(HealthPage, { overview: emptyOverview, refresh });
    expect(wrapper.text()).toContain('Not checked yet.');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(sent.map(request => request.path)).toEqual(['/api/health?refresh=1']);
    expect(refresh).toHaveBeenCalled();
  });

  it('explains when this dashboard cannot run checks', async () => {
    fakeServer({
      '/api/health?refresh=1': status(409, {
        error: {
          status: 409,
          code: 'conflict',
          message: 'Health checks are not available in this dashboard; run grampus doctor',
        },
      }),
    });
    const wrapper = await render(HealthPage, { overview: emptyOverview, refresh: vi.fn() });
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('run grampus doctor');
  });
});
