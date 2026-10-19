<script setup lang="ts">
/**
 * TaskSummaryItem: one task in the overview list (`TaskSummaryV1`): title, repository, status in words,
 * stage, slice, last activity, a stall badge and the usage headline. Unknown usage reads "Usage unknown",
 * never 0.
 *
 * Props:
 * - `task`: the server's `TaskSummaryV1`.
 */
import { computed } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { TaskSummaryV1, UsageCompleteness } from '../../../src/server/api-types';
import { useNow } from '../announcer';
import { href } from '../router';
import StatusBadge from './StatusBadge.vue';
import { elapsedSince, formatTokens, formatUsd, minutesSince, plural } from './format';

defineOptions({ name: 'TaskSummaryItem' });

const props = defineProps<{ task: TaskSummaryV1 }>();

const now = useNow();

const marks: Readonly<Record<UsageCompleteness, string>> = {
  complete: '',
  partial: ' (partial, a lower bound)',
  live: ' (live)',
  none: '',
};

const usage = computed(() => {
  const { tokens, estimatedCostUsd, completeness, turns, interventions } = props.task.usage;
  const measured =
    tokens === null
      ? 'Usage unknown'
      : `${formatTokens(tokens)} tokens${estimatedCostUsd === null ? '' : ` · ${formatUsd(estimatedCostUsd)} estimated`}${marks[completeness]}`;
  return `${measured} · ${plural(turns, 'turn')} · ${plural(interventions, 'intervention')}`;
});
</script>

<template>
  <li
    class="grid items-start gap-3 px-5 py-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
    :data-task="task.id"
  >
    <div class="min-w-0">
      <a
        :href="href({ name: 'task', id: task.id })"
        class="font-medium text-highlighted underline-offset-2 hover:underline"
        >{{ task.title }}</a
      >
      <p class="mt-1 text-xs text-muted">
        {{ task.repository.name }} · Slice {{ task.slice.index }} of {{ task.slice.count }}
      </p>
      <p class="mt-1 text-xs text-muted">{{ task.implementer.label }} implements, {{ task.reviewer.label }} reviews</p>
    </div>
    <div class="flex flex-col items-start gap-1">
      <StatusBadge :status="task.status" :label="task.statusLabel" size="sm" />
      <p class="text-xs text-muted">
        {{ task.stageLabel
        }}<template v-if="task.lastActivityAt">
          · last activity {{ elapsedSince(task.lastActivityAt, now) }} ago</template
        >
      </p>
      <span v-if="task.stalled" :title="task.stalled.message" data-stalled
        ><UBadge
          :label="`No activity for ${minutesSince(task.stalled.lastActivityAt, now)} min`"
          color="warning"
          variant="outline"
          size="sm"
          icon="i-lucide-clock-alert"
      /></span>
    </div>
    <p class="text-xs text-toned" data-usage>{{ usage }}</p>
    <a
      :href="href({ name: 'task', id: task.id })"
      class="grampus-link-button justify-self-start"
      :aria-label="`Open task: ${task.title}`"
      >Open task <span aria-hidden="true">→</span></a
    >
  </li>
</template>
