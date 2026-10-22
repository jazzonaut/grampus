<!-- The task's history, newest first, one line per event with its time. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { TimelineItem } from '../../../src/dashboard/types';
import { eventIcon, timeOfDay, toneColor, when } from '../presentation';

const props = defineProps<{ items: TimelineItem[] }>();

const newestFirst = computed(() => [...props.items].reverse());

const dot: Record<string, string> = {
  neutral: 'bg-elevated text-muted',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  error: 'bg-error/15 text-error',
};
</script>

<template>
  <ol
    class="relative space-y-4 before:absolute before:left-4 before:top-2 before:bottom-2 before:w-px before:bg-(--ui-border)"
  >
    <li v-for="(item, index) in newestFirst" :key="`${item.at}-${index}`" class="relative flex gap-3">
      <span
        class="z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-(--ui-bg)"
        :class="dot[toneColor[item.tone]]"
      >
        <UIcon :name="eventIcon(item.type)" class="size-4" />
      </span>
      <div class="min-w-0 pt-1">
        <p class="text-sm font-medium text-highlighted">
          {{ item.title }}
          <time class="ml-1 text-xs font-normal text-dimmed" :datetime="item.at" :title="when(item.at)">{{
            timeOfDay(item.at)
          }}</time>
        </p>
        <p v-if="item.detail" class="text-sm text-muted break-words whitespace-pre-line">{{ item.detail }}</p>
      </div>
    </li>
  </ol>
</template>
