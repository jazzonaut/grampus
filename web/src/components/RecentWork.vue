<script setup lang="ts">
/** Renders the server's compact native tool feed without turning observations into verified results. */
import type { TaskWorkV1 } from '../../../src/server/api-types';
import { href } from '../router';
import { localTime } from './format';

defineProps<{ id: string; work: TaskWorkV1 }>();
</script>

<template>
  <section class="grampus-surface" data-panel="recent-work" aria-label="Recent activity">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-highlighted">Recent activity</h2>
      <a :href="href({ name: 'observability', kind: 'task', id })" class="text-sm text-primary hover:underline">
        Full activity history →
      </a>
    </div>
    <ol v-if="work.recent.length" class="mt-3 divide-y divide-default">
      <li v-for="item in work.recent" :key="item.id" class="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 text-sm">
        <time :datetime="item.at" class="shrink-0 text-xs text-muted tabular-nums">{{ localTime(item.at) }}</time>
        <span class="break-words text-highlighted">{{ item.label }}</span>
      </li>
    </ol>
    <p v-else class="mt-3 text-sm text-muted">No native tool activity recorded for the latest agent turn.</p>
    <p class="mt-2 text-xs text-muted">
      Provider observations from the latest turn. Tool completion does not establish that controller checks passed.
      Commands are shortened and redacted; file details are not shown.
    </p>
  </section>
</template>
