// Guidance drafts survive progress, clear at approval boundaries and send the server's exact action.
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { FormField, GuidanceV1 } from '../../../src/server/api-types';
import GuidancePanel from './GuidancePanel.vue';
import { mockAction } from '../mock';
import { fakeServer, posts, render } from '../testing';

let mounted: VueWrapper | undefined;
afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
});

const text: FormField = {
  name: 'text',
  label: 'Your guidance',
  input: 'textarea',
  value: '',
  required: true,
  help: null,
  suggestions: [],
  options: [],
  min: null,
  max: null,
  step: null,
  placeholder: null,
  target: '/text',
};
const guidance: GuidanceV1 = {
  draftKey: '1:plan:0',
  messages: [],
  compose: mockAction('queue-guidance', 'Queue guidance', {
    path: '/api/tasks/task/guidance',
    expected: 'step-1',
    form: {
      kind: 'message',
      intro: 'Within the approved plan.',
      submitLabel: 'Queue guidance',
      fields: [
        text,
        {
          ...text,
          name: 'target',
          label: 'Send to',
          input: 'select',
          value: 'next_agent',
          target: '/target',
          options: [{ value: 'next_agent', label: 'Next agent turn', description: null }],
        },
      ],
    },
  }),
};

it('preserves a draft across stage changes and submits with the latest decision key', async () => {
  const sent = fakeServer({ 'POST /api/tasks/task/guidance': { ok: true } });
  const refresh = vi.fn(async () => {});
  mounted = await render(GuidancePanel, { guidance, refresh });
  const textarea = mounted.get('textarea');
  await textarea.setValue('Keep the approach direct.');
  const next: GuidanceV1 = {
    ...guidance,
    compose: {
      ...guidance.compose!,
      expected: 'step-2',
      request: { ...guidance.compose!.request, body: { expected: 'step-2' } },
    },
  };
  await mounted.setProps({ guidance: next });
  expect((mounted.get('textarea').element as HTMLTextAreaElement).value).toBe('Keep the approach direct.');
  await mounted.get('form').trigger('submit');
  await flushPromises();
  expect(posts(sent)).toEqual([
    {
      method: 'POST',
      path: '/api/tasks/task/guidance',
      body: { expected: 'step-2', text: 'Keep the approach direct.', target: 'next_agent' },
    },
  ]);
  expect((mounted.get('textarea').element as HTMLTextAreaElement).value).toBe('');
});

it('clears the draft when the approved version or slice changes', async () => {
  const sent = fakeServer({});
  mounted = await render(GuidancePanel, { guidance, refresh: async () => {} });
  await mounted.get('textarea').setValue('Old version guidance.');
  await mounted.setProps({ guidance: { ...guidance, draftKey: '2:new-plan:0' } });
  expect((mounted.get('textarea').element as HTMLTextAreaElement).value).toBe('');
  expect(posts(sent)).toEqual([]);
});
