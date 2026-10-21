<script setup lang="ts">
/**
 * TaskHeader: the summary at the top of a task: slice, title, status in words, the one-sentence
 * explanation, the next step (automatic, yours, or none), the controller's note, and notices for a
 * stale plan, a silent step and a failed dashboard action.
 *
 * Props:
 * - `header`: `TaskDetailV1.header`.
 */
import { computed } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { TaskDetailV1 } from '../../../src/server/api-types';
import { useNow } from '../announcer';
import MarkdownView from './MarkdownView.vue';
import NoticeBox from './NoticeBox.vue';
import StatusBadge from './StatusBadge.vue';
import { localTime, minutesSince } from './format';

defineOptions({ name: 'TaskHeader' });

const props = defineProps<{ header: TaskDetailV1['header']; active?: boolean }>();

const now = useNow();

const next = computed(() => {
  const step = props.header.nextStep;
  if (step.kind === 'automatic') return { prefix: 'Next, automatically:', text: step.label };
  if (step.kind === 'human') return { prefix: 'Your decision:', text: step.label };
  return { prefix: 'Next:', text: step.label };
});
</script>

<template>
  <header class="flex flex-col gap-3" data-panel="header">
    <p class="text-xs font-medium tracking-wide text-muted uppercase">
      Task · Slice {{ header.slice.index }} of {{ header.slice.count
      }}<template v-if="header.slice.count > 1"> · {{ header.slice.title }}</template>
    </p>
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-3xl font-semibold tracking-tight text-highlighted">{{ header.title }}</h1>
      <StatusBadge :status="header.status" :label="header.statusLabel" size="lg" />
      <UBadge
        :label="header.mode === 'automatic' ? 'Automatic' : 'Supervised'"
        color="neutral"
        variant="outline"
        size="sm"
      />
    </div>
    <p class="text-sm text-muted">
      <span class="font-mono">{{ header.repository.path }}</span>
    </p>
    <details class="text-sm text-toned" data-outcome>
      <summary class="cursor-pointer font-medium text-muted">Intended outcome</summary>
      <MarkdownView :source="header.outcome" class="mt-3 max-w-prose" />
    </details>
    <p v-if="!active" class="text-base text-default" data-explanation>{{ header.explanation }}</p>
    <p v-if="!active" class="text-sm" data-next-step :data-kind="header.nextStep.kind">
      <strong class="text-highlighted">{{ next.prefix }}</strong> {{ next.text }}
    </p>
    <NoticeBox v-if="header.stale" tone="warning" title="The approved plan is stale">
      The repository or plan changed after approval. Create a new task with the updated requirements; this one can only
      be reset or deleted.
    </NoticeBox>
    <NoticeBox
      v-if="header.stalled"
      tone="warning"
      :title="`No activity for ${minutesSince(header.stalled.lastActivityAt, now)} min`"
    >
      {{ header.stalled.message }}
    </NoticeBox>
    <NoticeBox v-if="header.actionError" tone="error" title="A dashboard action failed">
      <p>{{ header.actionError.message }}</p>
      <p v-if="header.actionError.at" class="text-xs text-muted">
        {{ header.actionError.action }} · {{ localTime(header.actionError.at) }}
      </p>
    </NoticeBox>
    <div
      v-if="header.note && (!active || header.stopReason)"
      class="rounded-lg border border-default bg-muted px-4 py-3 text-sm"
      data-note
    >
      <p class="mb-1 text-xs font-medium text-muted">
        Note from Grampus<template v-if="header.stopReason">
          · <span class="font-mono">{{ header.stopReason.code }}</span> ·
          {{ localTime(header.stopReason.at) }}</template
        >
      </p>
      <MarkdownView :source="header.note" />
    </div>
  </header>
</template>
