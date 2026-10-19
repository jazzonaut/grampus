<script setup lang="ts">
/**
 * TimelinePanel: a task's journal in UI language, newest first. The latest entries come with the task;
 * the full history is fetched on request, a page at a time (`TimelinePageV1`).
 *
 * Props:
 * - `timeline`: `DetailsV1.timeline` (total, recent entries and the paging path).
 */
import { ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { DetailsV1, TimelineEntryV1, TimelinePageV1 } from '../../../src/server/api-types';
import { ApiError, get } from '../api/client';
import { timelinePageEntries } from '../settings';
import { localTime } from './format';

defineOptions({ name: 'TimelinePanel' });

const props = defineProps<{ timeline: DetailsV1['timeline'] }>();

const full = ref<TimelineEntryV1[] | null>(null);
const cursor = ref<number | null>(null);
const loading = ref(false);
const error = ref('');

async function load(from: number | null): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const query = `?limit=${timelinePageEntries}${from === null ? '' : `&cursor=${from}`}`;
    const page = await get<TimelinePageV1>(`${props.timeline.path}${query}`);
    full.value = from === null ? page.entries : [...(full.value ?? []), ...page.entries];
    cursor.value = page.nextCursor;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

function collapse(): void {
  full.value = null;
  cursor.value = null;
}
</script>

<template>
  <div class="flex flex-col gap-2" data-panel="timeline">
    <ol class="flex flex-col divide-y divide-default text-sm" aria-label="Timeline, newest first">
      <li v-for="entry in full ?? timeline.recent" :key="entry.sequence" class="flex flex-col gap-0.5 py-2">
        <div class="flex flex-wrap items-baseline gap-2">
          <time :datetime="entry.at" class="text-xs text-muted tabular-nums">{{ localTime(entry.at) }}</time>
          <span class="font-medium text-highlighted">{{ entry.summary }}</span>
          <span v-if="entry.reasonCode" class="font-mono text-xs text-muted">{{ entry.reasonCode }}</span>
        </div>
        <p v-if="entry.note" class="text-xs whitespace-pre-line text-toned">{{ entry.note }}</p>
      </li>
    </ol>
    <p v-if="!timeline.total" class="text-sm text-muted">Nothing recorded yet.</p>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <UButton
        v-if="full === null && timeline.total > timeline.recent.length"
        :label="`View full timeline (${timeline.total})`"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loading"
        @click="load(null)"
      />
      <UButton
        v-if="full !== null && cursor !== null"
        label="Load older entries"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loading"
        @click="load(cursor)"
      />
      <UButton
        v-if="full !== null"
        label="Show recent activity"
        size="sm"
        color="neutral"
        variant="ghost"
        @click="collapse"
      />
    </div>
  </div>
</template>
