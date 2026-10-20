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
  it('shows live observability and links to planning replay before a task exists', async () => {
    const { wrapper, sent } = await open();
    expect(wrapper.find('[aria-label="Live observability"]').exists()).toBe(true);
    expect(wrapper.find('a[href="#/planning/kickoff-1/observability"]').exists()).toBe(true);
    expect(sent.some(request => request.path === '/api/v1/kickoffs/kickoff-1/observability')).toBe(true);
  });

  it('shows the discussion as Markdown, the questions, the proposal and the planning context', async () => {
    const { wrapper } = await open();
    const discussion = wrapper.get('[data-panel="discussion"]');
    expect(discussion.findAll('[data-role]').map(item => item.attributes('data-role'))).toEqual(['user', 'planner']);
    expect(discussion.html()).toContain('<strong>version</strong>');
    expect(wrapper.find('[data-decision="plan-answer"]').exists()).toBe(true);
    expect(wrapper.find('[data-panel="plan"]').exists()).toBe(false);
    expect(wrapper.get('[data-usage-headline]').text()).toContain('195,244 tokens');
    expect(wrapper.find('[data-panel="planning-context"]').exists()).toBe(false);
    await wrapper
      .findAll('button')
      .find(button => button.text().includes('Context and resources'))!
      .trigger('click');
    expect(wrapper.text()).toContain('40 files in the pinned commit');
    await wrapper.get('[role="tablist"] button:nth-child(2)').trigger('click');
    const plan = wrapper.get('[data-panel="plan"]');
    expect(plan.get('[data-slice="1"]').attributes('open')).toBeUndefined();
    expect(plan.text()).toContain('A transient failure is retried');
    expect(plan.get('[data-expected-stdout]').text()).toBe('"ok\\n"');
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(
      wrapper.get('[role="tab"][aria-selected="true"]').attributes('id'),
    );
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
    await wrapper
      .findAll('button')
      .find(button => button.text().includes('Context and resources'))!
      .trigger('click');
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
    await wrapper.get('[role="tablist"] button:nth-child(2)').trigger('click');
    await wrapper.get('[data-decision="prepare"] button').trigger('click');
    await flushPromises();
    expect(posts(sent)).toEqual([
      { method: 'POST', path: '/api/kickoffs/kickoff-1/prepare', body: { digest: 'e'.repeat(64) } },
    ]);
    expect(route.value).toEqual({ name: 'task', id: 'task-9' });
  });
  it('preserves feedback when inspecting a proposal and returns focus when requesting changes', async () => {
    const { wrapper, sent } = await open();
    const answer = wrapper.get('[data-decision="plan-answer"] textarea');
    await answer.setValue('Keep the current format');
    await wrapper.get('[role="tablist"] button:nth-child(2)').trigger('click');
    expect(wrapper.get('[data-panel="discussion"]').isVisible()).toBe(false);
    expect(posts(sent)).toEqual([]);
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Request changes')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-panel="discussion"]').isVisible()).toBe(true);
    expect((answer.element as HTMLTextAreaElement).value).toBe('Keep the current format');
    expect(document.activeElement).toBe(answer.element);
    expect(posts(sent)).toEqual([]);
  });
});
