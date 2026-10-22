<!-- The raw event log, filterable by type and text, for checking the evidence behind every view. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { StoredEvent } from '../../../src/domain/events';
import { getJson } from '../api/client';
import { timeOfDay } from '../presentation';

const props = defineProps<{ taskId: string; updatedAt: string }>();

const events = ref<StoredEvent[]>([]);
const error = ref<string | null>(null);
const types = ref<StoredEvent['type'][]>([]);
const search = ref('');

async function load(): Promise<void> {
  try {
    events.value = await getJson<StoredEvent[]>(`/api/tasks/${encodeURIComponent(props.taskId)}/events`);
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  }
}
watch(() => [props.taskId, props.updatedAt], load, { immediate: true });

const typeItems = computed(() => [...new Set(events.value.map(event => event.type))].sort());
const shown = computed(() => {
  const words = search.value.trim().toLowerCase();
  return events.value
    .map((event, index) => ({ event, index, text: JSON.stringify(event, null, 2) }))
    .filter(({ event }) => !types.value.length || types.value.includes(event.type))
    .filter(({ text }) => !words || text.toLowerCase().includes(words))
    .reverse();
});
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-col sm:flex-row gap-2">
      <USelectMenu
        v-model="types"
        :items="typeItems"
        multiple
        placeholder="All event types"
        icon="i-lucide-filter"
        class="sm:w-72"
      />
      <UInput v-model="search" icon="i-lucide-search" placeholder="Search events" class="flex-1" />
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <p class="text-xs text-muted">
      {{ shown.length }} of {{ events.length }} events, newest first. This is the task's append-only evidence log.
    </p>
    <UCollapsible v-for="{ event, index, text } in shown" :key="index" class="rounded-md border border-default">
      <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated/50">
        <span class="font-mono text-xs text-dimmed w-8 text-right">{{ index }}</span>
        <UBadge variant="subtle" color="neutral" class="font-mono">{{ event.type }}</UBadge>
        <span class="ml-auto text-xs text-dimmed">{{ timeOfDay(event.at) }}</span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-dimmed" />
      </button>
      <template #content>
        <pre class="overflow-x-auto border-t border-default px-3 py-2 text-xs">{{ text }}</pre>
      </template>
    </UCollapsible>
  </div>
</template>
