<script setup lang="ts">
// Root component: the shell (header health, sidebar, footer), the open screen from the URL fragment and
// the access-link state. The overview is polled here because the header and sidebar show it on every
// screen; a task or planning screen polls its own view while it is open. Nothing is polled while the tab
// is hidden or the server has required a fresh access link.
import { computed, defineAsyncComponent } from 'vue';
import UApp from '@nuxt/ui/components/App.vue';
import type { OverviewV1 } from '../../src/server/api-types';
import { accessMessage, get, needsAccessLink } from './api/client';
import { usePolled } from './api/usePolled';
import { announcement } from './announcer';
import { route } from './router';
import { pollIntervalMs } from './settings';
import AppBreadcrumb from './components/AppBreadcrumb.vue';
import AppShell from './components/AppShell.vue';
import AppSidebar from './components/AppSidebar.vue';
import EmptyState from './components/EmptyState.vue';
import ErrorBanner from './components/ErrorBanner.vue';
import HealthIndicator from './components/HealthIndicator.vue';
import { localTime } from './components/format';
import HealthPage from './pages/HealthPage.vue';
import HomePage from './pages/HomePage.vue';
import NewTaskPage from './pages/NewTaskPage.vue';
import PlanningPage from './pages/PlanningPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import ModelProfilesPage from './pages/ModelProfilesPage.vue';
import ComparisonsPage from './pages/ComparisonsPage.vue';
import ComparisonPage from './pages/ComparisonPage.vue';
import TaskPage from './pages/TaskPage.vue';
const ObservabilityPage = defineAsyncComponent(() => import('./pages/ObservabilityPage.vue'));

const overview = usePolled(() => get<OverviewV1>('/api/v1/overview'), pollIntervalMs, {
  enabled: () => !needsAccessLink.value,
});

const refresh = () => overview.refresh();

const connection = computed(() => {
  if (overview.error.value && overview.error.value.status === 0) return 'unreachable';
  return overview.data.value ? 'connected' : 'connecting';
});

const application = computed(() => overview.data.value?.application);
</script>

<template>
  <UApp>
    <AppShell :announcement="announcement">
      <template #breadcrumb><AppBreadcrumb :current="route" :overview="overview.data.value" /></template>
      <template #health>
        <HealthIndicator v-if="!needsAccessLink" :health="overview.data.value?.health" :connection="connection" />
      </template>
      <template #sidebar>
        <AppSidebar :overview="overview.data.value" :current="route" />
      </template>
      <ErrorBanner v-if="needsAccessLink" kind="access" :message="accessMessage" class="mx-auto max-w-3xl" />
      <template v-else>
        <ErrorBanner
          v-if="overview.error.value && overview.error.value.status !== 401"
          :message="overview.error.value.message"
          title="The overview could not be refreshed"
          retry-label="Try again"
          class="mx-auto mb-4 max-w-5xl"
          @retry="refresh"
        />
        <HomePage v-if="route.name === 'home'" :overview="overview.data.value" :refresh="refresh" />
        <NewTaskPage v-else-if="route.name === 'new'" />
        <HealthPage v-else-if="route.name === 'health'" :overview="overview.data.value" :refresh="refresh" />
        <ModelProfilesPage v-else-if="route.name === 'profiles'" />
        <ComparisonsPage v-else-if="route.name === 'comparisons'" />
        <ComparisonPage v-else-if="route.name === 'comparison'" :id="route.id" :key="`comparison-${route.id}`" />
        <SettingsPage v-else-if="route.name === 'settings'" />
        <TaskPage v-else-if="route.name === 'task'" :id="route.id" :key="`task-${route.id}`" />
        <ObservabilityPage
          v-else-if="route.name === 'observability'"
          :id="route.id"
          :key="`observability-${route.kind}-${route.id}`"
          :kind="route.kind"
        />
        <PlanningPage v-else-if="route.name === 'planning'" :id="route.id" :key="`planning-${route.id}`" />
        <EmptyState
          v-else
          title="This screen does not exist"
          description="The link may be incomplete."
          icon="i-lucide-map-pin-off"
        >
          <template #actions><a href="#/" class="grampus-link-button">Open the overview</a></template>
        </EmptyState>
      </template>
      <template #footer>
        <span v-if="application" data-footer>
          Windows alpha · {{ application.name }} {{ application.version }} ({{ application.channel }})<template
            v-if="application.build"
          >
            · build
            <span :title="`Built ${localTime(application.build.builtAt)}`">{{ application.build.id }}</span></template
          >
          · journal <span class="font-mono">{{ application.journal }}</span>
        </span>
      </template>
    </AppShell>
  </UApp>
</template>
