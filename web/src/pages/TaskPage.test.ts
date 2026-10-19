import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import TaskPage from './TaskPage.vue';
import type { TaskDetailV1 } from '../../../src/server/api-types';
import { mockAction, mockTask } from '../mock';
import { fakeServer, posts, render, status } from '../testing';

let mounted: VueWrapper | undefined;

afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
});

async function open(routes: Parameters<typeof fakeServer>[0]) {
  const sent = fakeServer({ '/api/v1/tasks/task-1': mockTask, ...routes });
  mounted = await render(TaskPage, { id: 'task-1' });
  return { wrapper: mounted, sent };
}

describe('TaskPage', () => {
  it('draws the summary, workflow, decisions, results, usage and details from the task view', async () => {
    const { wrapper } = await open({});
    expect(wrapper.get('h1').text()).toBe('Add retry to the export job');
    expect(wrapper.get('[data-explanation]').text()).toBe('The implementer asked a question before continuing.');
    expect(wrapper.get('[data-next-step]').text()).toBe('Your decision: Answer the questions.');
    expect(wrapper.get('[data-note]').html()).toContain('<strong>care</strong>');
    // The workflow strip is data-driven and names who established each result.
    expect(wrapper.findAll('[data-stage]').map(stage => stage.attributes('data-stage'))).toEqual(
      mockTask.workflow.map(stage => stage.id),
    );
    expect(wrapper.get('[data-stage="validate"]').text()).toContain('verified by Grampus');
    expect(wrapper.get('[data-stage="implement"]').text()).toContain('agent reported');
    expect(wrapper.get('[data-stage="review"]').text()).toContain('Simplification');
    // Decisions: the answer form here; revision and management elsewhere.
    expect(wrapper.find('[data-panel="decisions"] [data-decision="answer"]').exists()).toBe(true);
    expect(wrapper.find('[data-panel="decisions"] [data-decision="revise"]').exists()).toBe(false);
    expect(wrapper.find('[data-panel="decisions"] [data-decision="report"]').exists()).toBe(false);
    expect(wrapper.find('[data-panel="report"]').exists()).toBe(false); // Created when Details > Report opens.
    expect(wrapper.text()).toContain('Manage task');
    // Results.
    expect(wrapper.get('[data-unresolved]').text()).toContain('1 blocking review finding');
    expect(wrapper.get('[data-check="check-1"] [data-issue]').text()).toBe('AssertionError: expected 3 retries');
    expect(wrapper.get('[data-lens="simplification"]').text()).toContain('reviewer failed it');
    // Usage: unknown is never 0.
    const claude = wrapper.findAll('td[data-metric="inputTokens"]').map(cell => cell.text());
    expect(claude).toContain('Unknown');
    expect(wrapper.get('[data-totals]').text()).toContain('1 human intervention after approval (1 answer)');
    expect(wrapper.get('[data-wall]').text()).toBe('1m 35s+');
    expect(wrapper.text()).toContain('Question asked');
  });

  it('fills an answer from a suggestion and posts exactly the server body with the decision key', async () => {
    const { wrapper, sent } = await open({ 'POST /api/tasks/task-1/answer': status(202, { ok: true }) });
    const card = wrapper.get('[data-decision="answer"]');
    await card.get('[data-field="answer-0"] [data-suggestion]').trigger('click');
    await card.get('[data-field="answer-1"] textarea').setValue('Keep it');
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(posts(sent)).toEqual([
      {
        method: 'POST',
        path: '/api/tasks/task-1/answer',
        body: { expected: 'decision-7', answers: { redirect: 'Yes, permanently', 'a/b': 'Keep it' } },
      },
    ]);
    expect(wrapper.get('[data-notice="requested"]').text()).toContain('requested');
  });

  it('shows field problems and sends nothing when a required answer is empty', async () => {
    const { wrapper, sent } = await open({});
    await wrapper.get('[data-decision="answer"] form').trigger('submit');
    await flushPromises();
    expect(posts(sent)).toEqual([]);
    expect(wrapper.findAll('[data-decision="answer"] [data-issue]')).toHaveLength(2);
    expect(wrapper.get('[data-decision="answer"] textarea').attributes('aria-invalid')).toBe('true');
  });

  it('refetches calmly when the server says the page was stale (409)', async () => {
    let reads = 0;
    const { wrapper } = await open({
      '/api/v1/tasks/task-1': () => {
        reads += 1;
        return mockTask;
      },
      'POST /api/tasks/task-1/answer': status(409, {
        error: { status: 409, code: 'stale_state', message: 'Task changed' },
      }),
    });
    const before = reads;
    const card = wrapper.get('[data-decision="answer"]');
    await card.get('[data-field="answer-0"] textarea').setValue('a');
    await card.get('[data-field="answer-1"] textarea').setValue('b');
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-notice="stale"]').text()).toContain('did not act on it');
    expect(reads).toBeGreaterThan(before);
  });

  it('says calmly that every runner slot is in use when the server refuses with pool_full (409)', async () => {
    let reads = 0;
    const { wrapper } = await open({
      '/api/v1/tasks/task-1': () => {
        reads += 1;
        return mockTask;
      },
      'POST /api/tasks/task-1/answer': status(409, {
        error: { status: 409, code: 'pool_full', message: '2 of 2 guided tasks are already running' },
      }),
    });
    const before = reads;
    const card = wrapper.get('[data-decision="answer"]');
    await card.get('[data-field="answer-0"] textarea').setValue('a');
    await card.get('[data-field="answer-1"] textarea').setValue('b');
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-notice="pool"]').text()).toContain('Every runner slot is in use');
    expect(wrapper.find('[data-notice="error"]').exists()).toBe(false);
    expect(wrapper.find('[data-notice="stale"]').exists()).toBe(false);
    expect(reads).toBeGreaterThan(before);
  });

  it('explains an approval that waits for a free runner slot (started: false)', async () => {
    const approve = mockAction('approve', 'Approve and start', {
      kind: 'primary',
      path: '/api/tasks/task-1/approve',
      body: { expected: 'decision-7', version: 3, digest: 'f'.repeat(64) },
    });
    const { wrapper } = await open({
      '/api/v1/tasks/task-1': { ...mockTask, decisions: [approve] },
      'POST /api/tasks/task-1/approve': { ok: true, started: false },
    });
    await wrapper.get('[data-decision="approve"] button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-notice="pool"]').text()).toContain('Approved. Every runner slot is in use');
    expect(wrapper.find('[data-notice="requested"]').exists()).toBe(false);
  });

  it('asks before deleting and then sends the delete body', async () => {
    const { wrapper, sent } = await open({ 'POST /api/tasks/task-1/delete': { ok: true } });
    await wrapper.get('[data-action="delete"] button').trigger('click');
    expect(posts(sent)).toEqual([]);
    expect(wrapper.get('[data-action="delete"]').text()).toContain('Delete this task from the dashboard?');
    await wrapper.get('[data-action="delete"] [data-confirm]').trigger('click');
    await flushPromises();
    expect(posts(sent)).toEqual([
      { method: 'POST', path: '/api/tasks/task-1/delete', body: { expected: 'decision-7' } },
    ]);
  });

  it('shows live activity with Stop, and a stall notice', async () => {
    const working: TaskDetailV1 = {
      ...mockTask,
      header: {
        ...mockTask.header,
        status: 'working',
        statusLabel: 'Working',
        stalled: {
          since: '2026-10-19T09:10:00.000Z',
          lastActivityAt: '2026-10-19T09:00:00.000Z',
          owner: 'Codex session',
          message: 'Nothing has been stopped.',
        },
      },
      activity: {
        title: 'Implementing the change',
        description: 'Requested file changes: src/export.ts',
        actor: 'implementer',
        provider: { id: 'codex', label: 'Codex', model: null },
        stageLabel: 'Implement',
        startedAt: '2026-10-19T09:00:00.000Z',
        lastActivityAt: '2026-10-19T09:00:00.000Z',
        repositoryCalls: 3,
        integrationCalls: 0,
        fileRequests: 1,
        recent: ['Read src/export.ts'],
      },
      decisions: [
        {
          ...mockTask.decisions[4]!,
          id: 'stop',
          label: 'Stop now',
          confirm: null,
          request: { method: 'POST', path: '/api/tasks/task-1/stop', body: { expected: 'decision-7' } },
        },
      ],
    };
    const { wrapper } = await open({ '/api/v1/tasks/task-1': working });
    const activity = wrapper.get('[data-panel="activity"]');
    expect(activity.text()).toContain('Implementing the change');
    expect(activity.text()).toContain('3 repository actions · 0 MCP requests · 1 file change request');
    expect(activity.find('[data-action="stop"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Nothing has been stopped.');
    expect(wrapper.text()).not.toMatch(/\d+%/);
  });

  it('explains a deleted task', async () => {
    fakeServer({
      '/api/v1/tasks/task-1': status(404, {
        error: { status: 404, code: 'not_found', message: 'This task was deleted' },
      }),
    });
    mounted = await render(TaskPage, { id: 'task-1' });
    expect(mounted.text()).toContain('This task is not available');
  });
});
