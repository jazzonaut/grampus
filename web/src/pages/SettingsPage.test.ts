import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { FormField, SettingsV1 } from '../../../src/server/api-types';
import SettingsPage from './SettingsPage.vue';
import { mockAction } from '../mock';
import { fakeServer, posts, render, status } from '../testing';

afterEach(() => {
  document.body.innerHTML = '';
});

const number = (name: string, value: number | null): FormField => ({
  name,
  label: name,
  input: 'number',
  value,
  required: false,
  help: null,
  suggestions: [],
  options: [],
  min: 1,
  max: 4,
  step: 1,
  placeholder: 'Default 2',
  target: `/overrides/${name}`,
});

function settingsView(revision: string, value: number | null, extra: Partial<SettingsV1> = {}): SettingsV1 {
  return {
    apiVersion: 1,
    file: 'C:\\Grampus\\config.json',
    restartRequired: false,
    problem: null,
    save: mockAction('save-settings', 'Save settings', {
      path: '/api/settings',
      kind: 'primary',
      expected: revision,
      body: { expected: revision, overrides: {} },
      form: {
        kind: 'settings',
        intro: null,
        fields: [number('maxConcurrentTasks', value), number('stallWarningMs', null)],
        submitLabel: 'Save settings',
      },
    }),
    ...extra,
  };
}

const field = (name: string) => `[data-field="${name}"] input`;

describe('SettingsPage', () => {
  it('saves only the fields with a value against the shown revision, then says a restart applies them', async () => {
    let current = settingsView('absent', null);
    const sent = fakeServer({
      '/api/v1/settings': () => current,
      'POST /api/settings': () => {
        current = settingsView('rev-2', 3, { restartRequired: true });
        return { ok: true };
      },
    });
    const wrapper = await render(SettingsPage);
    expect(wrapper.get('[data-file]').text()).toContain('C:\\Grampus\\config.json');
    await wrapper.get(field('maxConcurrentTasks')).setValue('3');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(posts(sent).map(request => request.body)).toEqual([
      { expected: 'absent', overrides: { maxConcurrentTasks: 3 } },
    ]);
    expect(wrapper.find('[data-restart]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Settings saved');
    expect((wrapper.get(field('maxConcurrentTasks')).element as HTMLInputElement).value).toBe('3');
  });

  it('shows the refusal of an invalid value and sends nothing for a value outside the shown range', async () => {
    const sent = fakeServer({
      '/api/v1/settings': settingsView('rev-1', null),
      'POST /api/settings': status(400, {
        error: { status: 400, code: 'refused', message: 'Invalid settings in the settings form: too short' },
      }),
    });
    const wrapper = await render(SettingsPage);
    await wrapper.get(field('maxConcurrentTasks')).setValue('9');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(posts(sent)).toHaveLength(0);
    expect(wrapper.get('[data-issue]').text()).toContain('4 or less');

    await wrapper.get(field('maxConcurrentTasks')).setValue('3');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-failure]').text()).toContain('too short');
  });

  it('rereads the file after a stale save and reports a file Grampus would refuse', async () => {
    let current = settingsView('rev-1', null);
    fakeServer({
      '/api/v1/settings': () => current,
      'POST /api/settings': () => {
        current = settingsView('rev-2', 2, { problem: 'Invalid settings in config.json: "stallWarningMs": too small' });
        return status(409, { error: { status: 409, code: 'stale_state', message: 'config.json changed' } });
      },
    });
    const wrapper = await render(SettingsPage);
    await wrapper.get(field('maxConcurrentTasks')).setValue('3');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-failure]').text()).toContain('config.json changed');
    expect(wrapper.get('[data-problem]').text()).toContain('"stallWarningMs"');
    expect((wrapper.get(field('maxConcurrentTasks')).element as HTMLInputElement).value).toBe('2');
  });
});
