import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import NewTaskPage from './NewTaskPage.vue';
import type { InspectRepositoryResponse, KickoffDetailV1 } from '../../../src/server/api-types';
import { mockAction, mockKickoff } from '../mock';
import { route } from '../router';
import { fakeServer, posts, render } from '../testing';

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

const inspected: InspectRepositoryResponse = {
  repo: 'D:\\Projects\\exporter',
  base: 'a'.repeat(40),
  context: {
    inventoryDigest: 'inv',
    digest: 'd',
    totalFiles: 3,
    totalBytes: 30,
    includedFiles: 1,
    omittedFiles: 2,
    bytes: 10,
    selected: ['src/export.ts'],
    directories: [{ path: 'src', files: 3 }],
  },
};

const fresh: KickoffDetailV1 = {
  ...mockKickoff,
  id: 'k-new',
  messages: [],
  questions: [],
  actions: [
    mockAction('plan-message', 'Prepare a plan', {
      kind: 'primary',
      path: '/api/kickoffs/k-new/plan',
      expected: 'turn-0',
      form: {
        kind: 'message',
        intro: null,
        submitLabel: 'Prepare a plan',
        fields: [
          {
            name: 'message',
            label: 'Start planning',
            input: 'textarea',
            value: '',
            required: false,
            help: null,
            suggestions: [],
            options: [],
            min: null,
            max: null,
            step: null,
            placeholder: null,
            target: '/message',
          },
        ],
      },
    }),
  ],
};

describe('NewTaskPage', () => {
  it('labels every field of the kickoff form', async () => {
    fakeServer({});
    const wrapper = await render(NewTaskPage);
    for (const label of [
      'Repository folder',
      'What should be different',
      'Reference folders',
      'Planner and implementer',
      'Workspace',
    ])
      expect(
        wrapper.findAll('label').some(item => item.text().includes(label)),
        label,
      ).toBe(true);
    for (const control of wrapper.findAll('input, textarea, select')) {
      const id = control.attributes('id');
      expect(id && wrapper.find(`label[for="${id}"]`).exists(), id).toBe(true);
    }
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('creates the kickoff with every field, then sends the first planning turn and opens it', async () => {
    const sent = fakeServer({
      'POST /api/repositories/inspect': inspected,
      'POST /api/kickoffs': { id: 'k-new' },
      '/api/v1/kickoffs/k-new': fresh,
      'POST /api/kickoffs/k-new/plan': { ok: true },
      'POST /api/references/suggest': {
        suggestions: [{ path: 'D:\\Specs', reason: 'Folder mentioned in the task description' }],
      },
    });
    const wrapper = await render(NewTaskPage);
    await wrapper.get('#new-repo').setValue('D:\\Projects\\exporter');
    await wrapper.get('#new-request').setValue('Retry exports. See D:\\Specs');
    await wrapper.get('#new-provider').setValue('claude');
    await wrapper.get('#new-adapter').setValue('orca');
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Suggest from task description')!
      .trigger('click');
    await flushPromises();
    await wrapper.get('ul[aria-label="Suggested reference folders"] button').trigger('click');
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Suggest starting files')!
      .trigger('click');
    await flushPromises();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(posts(sent).map(request => request.path)).toEqual([
      '/api/references/suggest',
      '/api/repositories/inspect',
      '/api/kickoffs',
      '/api/kickoffs/k-new/plan',
    ]);
    expect(posts(sent)[2]?.body).toEqual({
      repo: 'D:\\Projects\\exporter',
      request: 'Retry exports. See D:\\Specs',
      provider: 'claude',
      adapter: 'orca',
      references: ['D:\\Specs'],
      base: 'a'.repeat(40),
      contextFiles: ['src/export.ts'],
    });
    expect(posts(sent)[3]?.body).toEqual({ expected: 'turn-0', message: '' });
    expect(route.value).toEqual({ name: 'planning', id: 'k-new' });
  });

  it('imports an authored plan and opens the task', async () => {
    const sent = fakeServer({ 'POST /api/tasks': { id: 'task-7' } });
    const wrapper = await render(NewTaskPage);
    const form = wrapper.get('[data-panel="import"] form');
    await form.get('textarea').setValue('{"brief":{}}');
    await form.trigger('submit');
    await flushPromises();
    expect(posts(sent)).toEqual([{ method: 'POST', path: '/api/tasks', body: { plan: { brief: {} } } }]);
    expect(route.value).toEqual({ name: 'task', id: 'task-7' });
  });
});
