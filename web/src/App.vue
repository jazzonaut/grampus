<script setup lang="ts">
// Root component. Polls the server's state so the header shows whether the dashboard is
// connected; the main area is the component gallery until real screens are built on the
// typed view-model API.
import { computed } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import { get, needsAccessLink } from './api/client';
import { usePolled } from './api/usePolled';
import DemoPage from './pages/DemoPage.vue';
import type { Status } from './theme/status';

/** The part of `GET /api/state` the shell reads. */
interface StateSummary {
  readonly tasks: readonly unknown[];
  readonly application?: { readonly version?: string; readonly channel?: string };
}

const state = usePolled(() => get<StateSummary>('/api/state'), 1500, { enabled: () => !needsAccessLink.value });

const connection = computed((): { status: Status; label: string } => {
  if (needsAccessLink.value) return { status: 'blocked', label: 'Access link needed' };
  if (state.error.value) return { status: 'unknown', label: 'Server not reachable' };
  if (state.data.value) return { status: 'verified', label: 'Connected' };
  return { status: 'working', label: 'Connecting' };
});

const version = computed(() => {
  const application = state.data.value?.application;
  return application?.version ? `Grampus ${application.version} (${application.channel ?? 'unknown channel'})` : '';
});
</script>

<template>
  <UApp>
    <DemoPage
      :connection="connection.status"
      :connection-label="connection.label"
      :access-required="needsAccessLink"
      :version="version"
    />
  </UApp>
</template>
