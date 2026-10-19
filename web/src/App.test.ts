import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import App from './App.vue';
import { bootstrapToken, tokenStorageKey } from './api/client';
import { mockOverview } from './mock';
import { navigate, syncRoute } from './router';
import { fakeServer, render, status } from './testing';

let mounted: VueWrapper | undefined;

afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = '';
  window.location.hash = '';
});

describe('App', () => {
  it('asks for the access link when the server refuses the token, and polls nothing more', async () => {
    fakeServer({
      '/api/v1/overview': status(401, { error: { status: 401, code: 'unauthorized', message: 'Open the link' } }),
    });
    mounted = await render(App);
    expect(mounted.text()).toContain('Access link needed');
    expect(mounted.text()).toContain('Open the complete local dashboard link printed by Grampus.');
    const calls = vi.mocked(fetch).mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    await flushPromises();
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });

  it('asks for the access link without a token and never calls the server', async () => {
    fakeServer({});
    window.sessionStorage.removeItem(tokenStorageKey);
    bootstrapToken();
    mounted = await render(App);
    expect(mounted.text()).toContain('Access link needed');
    expect(fetch).not.toHaveBeenCalled();
    // A fresh link restores access.
    window.history.replaceState(null, '', `/#${'c'.repeat(64)}`);
    bootstrapToken();
  });

  it('shows the overview, header health, sidebar and footer, and switches screens from the fragment', async () => {
    fakeServer({ '/api/v1/overview': mockOverview });
    bootstrapToken();
    syncRoute();
    mounted = await render(App);
    expect(mounted.get('h1').text()).toBe('Overview');
    expect(mounted.get('header [data-overall="degraded"]').text()).toContain('Integrations need attention');
    expect(mounted.get('nav').text()).toContain('Add retry to the export job');
    expect(mounted.get('[data-footer]').text()).toContain('Grampus 0.1.0 (development)');
    navigate({ name: 'health' });
    await flushPromises();
    expect(mounted.get('h1').text()).toBe('Integration health');
    expect(mounted.get('nav a[aria-current="page"]').text()).toBe('Integration health');
  });
});
