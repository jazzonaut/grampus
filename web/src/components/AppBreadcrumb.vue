<script setup lang="ts">
/** Owns navigation context in the shared header without inventing dashboard destinations. */
import { computed } from 'vue';
import type { OverviewV1 } from '../../../src/server/api-types';
import { href, type Route } from '../router';
const props = defineProps<{ current: Route; overview: OverviewV1 | undefined }>();
function taskTitle(id: string): string {
  return props.overview?.tasks.find(item => item.id === id)?.title ?? 'Task';
}
function planningTitle(id: string): string {
  return props.overview?.planning.find(item => item.id === id)?.title ?? 'Planning conversation';
}
const label = computed(() => {
  const current = props.current;
  switch (current.name) {
    case 'observability':
      return `${current.kind === 'task' ? taskTitle(current.id) : planningTitle(current.id)} › Agent observability`;
    case 'task':
      return taskTitle(current.id);
    case 'planning':
      return planningTitle(current.id);
    case 'new':
      return 'New task';
    case 'health':
      return 'Integration health';
    case 'settings':
      return 'Settings';
    case 'not-found':
      return 'Screen not found';
    case 'home':
      return 'Overview';
  }
});
</script>

<template>
  <nav aria-label="Breadcrumb" class="hidden min-w-0 items-center gap-3 text-sm md:flex">
    <a :href="href({ name: 'home' })" class="shrink-0 text-muted hover:text-primary">Overview</a>
    <template v-if="current.name !== 'home'"
      ><span aria-hidden="true" class="text-dimmed">›</span
      ><span aria-current="page" class="truncate font-medium text-highlighted">{{ label }}</span></template
    >
  </nav>
</template>
