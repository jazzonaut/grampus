import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import PlanningPage from './PlanningPage.vue';
import { mockKickoff } from '../mock';
import { route } from '../router';
import { fakeServer, posts, render, status } from '../testing';

let mounted: VueWrapper | undefined;

afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
  window.location.hash = '';
});

async function open(routes: Parameters<typeof fakeServer>[0] = {}) {
  const sent = fakeServer({ '/api/v1/kickoffs/kickoff-1': mockKickoff, ...routes });
  mounted = await render(PlanningPage, { id: 'kickoff-1' });
  return { wrapper: mounted, sent };
}

describe('PlanningPage', () => {
  it('shows the discussion as Markdown, the questions, the proposal and the planning context', async () => {
    const { wrapper } = await open();
    const discussion = wrapper.get('[data-panel="discussion"]');
    expect(discussion.findAll('[data-role]').map(item => item.attributes('data-role'))).toEqual(['user', 'planner']);
    expect(discussion.html()).toContain('<strong>version</strong>');
    expect(wrapper.find('[data-decision="plan-answer"]').exists()).toBe(true);
    const plan = wrapper.get('[data-panel="plan"]');
    expect(plan.text()).toContain('A transient failure is retried');
    expect(plan.get('[data-expected-stdout]').text()).toBe('"ok\\n"');
    expect(wrapper.text()).toContain('40 files in the pinned commit');
  });

  it('answers with the turn key and the question ids', async () => {
    const { wrapper, sent } = await open({ 'POST /api/kickoffs/kickoff-1/plan': status(202, { ok: true }) });
    const card = wrapper.get('[data-decision="plan-answer"]');
    await card.get('[data-suggestion]').trigger('click');
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(posts(sent)).toEqual([
      {
        method: 'POST',
        path: '/api/kickoffs/kickoff-1/plan',
        body: { expected: 'turn-3', answers: { version: 'v2' } },
      },
    ]);
  });

  it('adds a suggested reference folder to the field before updating references', async () => {
    const { wrapper, sent } = await open({ 'POST /api/kickoffs/kickoff-1/references': { ok: true } });
    const card = wrapper.get('[data-decision="update-references"]');
    await card.get('ul[aria-label="Suggested reference folders"] button').trigger('click');
    expect((card.get('textarea').element as HTMLTextAreaElement).value).toBe('D:\\Specs');
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(posts(sent)).toEqual([
      {
        method: 'POST',
        path: '/api/kickoffs/kickoff-1/references',
        body: { expected: 'turn-3', references: ['D:\\Specs'] },
      },
    ]);
  });

  it('prepares the proposal with its digest and opens the new task', async () => {
    const { wrapper, sent } = await open({ 'POST /api/kickoffs/kickoff-1/prepare': status(201, { id: 'task-9' }) });
    await wrapper.get('[data-decision="prepare"] button').trigger('click');
    await flushPromises();
    expect(posts(sent)).toEqual([
      { method: 'POST', path: '/api/kickoffs/kickoff-1/prepare', body: { digest: 'e'.repeat(64) } },
    ]);
    expect(route.value).toEqual({ name: 'task', id: 'task-9' });
  });
});
