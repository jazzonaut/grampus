<script setup lang="ts">
/** Owns the task's focal activity card; all activity and silence decisions come from the server. */
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { ActivityV1, TaskDetailV1, TaskWorkV1 } from '../../../src/server/api-types';
import { useNow } from '../announcer';
import { elapsedSince, localTime } from './format';

defineProps<{ activity: ActivityV1; work: TaskWorkV1; header: TaskDetailV1['header'] }>();
defineSlots<{ actions?: () => unknown }>();
const now = useNow();
</script>

<template>
  <section
    class="flex flex-col gap-4 rounded-xl border border-info/30 border-l-4 border-l-info bg-info/5 p-5"
    :class="{ 'border-warning/40 border-l-warning bg-warning/5': header.stalled }"
    data-panel="activity"
    aria-label="Current activity"
  >
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
      <UIcon
        :name="header.stalled ? 'i-lucide-clock-alert' : 'i-lucide-loader-circle'"
        class="size-4"
        :class="{ 'motion-safe:animate-spin': !header.stalled }"
        aria-hidden="true"
      />
      <span
        >{{ activity.title }}<template v-if="activity.provider"> · {{ activity.provider.label }}</template></span
      >
      <span v-if="activity.startedAt" class="ml-auto tabular-nums">
        Elapsed {{ elapsedSince(activity.startedAt, now) }}
      </span>
    </div>
    <div>
      <h2 class="text-xl font-semibold tracking-tight text-highlighted">
        {{ header.stalled ? 'No recent activity recorded' : activity.description }}
      </h2>
      <p v-if="header.stalled" class="mt-2 text-sm text-toned">
        Last reported: {{ activity.description }}. Current operation cannot be established from the quiet feed.
      </p>
      <p v-if="activity.lastActivityAt" class="mt-2 text-sm text-muted" data-last-activity>
        Last recorded activity {{ elapsedSince(activity.lastActivityAt, now) }} ago.
      </p>
    </div>
    <div v-if="work.update" class="rounded-lg bg-default/80 p-3" data-agent-update>
      <p class="mb-1 text-xs font-medium text-muted">
        Latest agent update · agent reported · {{ localTime(work.update.at) }}
      </p>
      <p class="text-sm break-words whitespace-pre-wrap">{{ work.update.text }}</p>
    </div>
    <div class="flex flex-wrap gap-3"><slot name="actions" /></div>
    <p class="text-xs text-muted">{{ header.nextStep.label }}</p>
  </section>
</template>
