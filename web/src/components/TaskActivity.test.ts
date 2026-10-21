// Pins the distinction between a workflow stage, observed activity and an attributed agent update.
import { afterEach, expect, it } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import type { ActivityV1 } from '../../../src/server/api-types';
import TaskActivity from './TaskActivity.vue';
import { mockTask } from '../mock';
import { render } from '../testing';

let mounted: VueWrapper | undefined;
afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
});

const activity: ActivityV1 = {
  title: 'Implementing the change',
  description: 'Running a command',
  actor: 'implementer',
  provider: { id: 'codex', label: 'Codex', model: null },
  stageLabel: 'Implement',
  startedAt: '2026-10-21T12:00:00Z',
  lastActivityAt: '2026-10-21T12:02:00Z',
  repositoryCalls: 0,
  integrationCalls: 0,
  fileRequests: 0,
  recent: [],
};

it('leads with observed activity and renders the attributed update as text', async () => {
  mounted = await render(TaskActivity, {
    activity,
    header: mockTask.header,
    work: { recent: [], update: { at: '2026-10-21T12:01:00Z', text: 'Checking <script>output</script>.' } },
  });
  expect(mounted.get('h2').text()).toBe('Running a command');
  expect(mounted.get('[data-agent-update]').text()).toContain('agent reported');
  expect(mounted.get('[data-agent-update]').text()).toContain('<script>output</script>');
  expect(mounted.find('script').exists()).toBe(false);
  expect(mounted.text()).not.toContain('0 MCP requests');
  expect(mounted.text()).toContain('Last recorded activity');
});

it('makes silence explicit without continuing to animate a working indicator', async () => {
  mounted = await render(TaskActivity, {
    activity,
    work: { recent: [], update: null },
    header: {
      ...mockTask.header,
      stalled: {
        since: '2026-10-21T12:12:00Z',
        lastActivityAt: activity.lastActivityAt,
        owner: 'Codex session',
        message: 'Nothing has been stopped.',
      },
    },
  });
  expect(mounted.get('h2').text()).toBe('No recent activity recorded');
  expect(mounted.text()).toContain('Last reported: Running a command');
  expect(mounted.text()).toContain('cannot be established');
  expect(mounted.find('.motion-safe\\:animate-spin').exists()).toBe(false);
});
