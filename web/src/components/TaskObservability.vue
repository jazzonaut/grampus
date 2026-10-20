<script setup lang="ts">
// Keeps the task's real communication network visible above its workflow and decisions.
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import { useObservability } from '../observability/useObservability';
import { compactGraph, graphFrame } from '../observability/graph';
import { href, navigate } from '../router';
import ExecutionGraph from './ExecutionGraph.vue';

const props = defineProps<{ id: string }>();
const activity = useObservability(() => props.id);
const frame = computed(() =>
  compactGraph(graphFrame(activity.poll.data.value?.nodes ?? [], activity.events.value, true)),
);
</script>

<template>
  <section class="rounded-xl border border-default bg-default p-4" aria-label="Live observability">
    <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 class="font-semibold text-highlighted">Live observability</h2>
        <p class="text-xs text-muted">
          Observed agents, models, tools and controller decisions. Completed participants remain in grey.
        </p>
      </div>
      <UButton
        :to="href({ name: 'observability', id })"
        color="neutral"
        variant="outline"
        size="sm"
        label="Open full observability"
        trailing-icon="i-lucide-maximize-2"
      />
    </div>
    <p v-if="activity.poll.error.value" role="alert" class="text-sm text-error">
      Activity unavailable: {{ activity.poll.error.value.message }}. Any graph shown is from the last successful read.
    </p>
    <p v-else-if="!activity.poll.data.value" class="text-sm text-muted">Reading recorded activity…</p>
    <ExecutionGraph
      v-if="activity.poll.data.value"
      :nodes="frame.nodes"
      :edges="frame.edges"
      :live="!activity.poll.error.value"
      compact
      @select="navigate({ name: 'observability', id })"
    />
    <p class="mt-2 text-xs text-muted">
      Provider-reported activity; missing telemetry remains unknown. Updates approximately every second with default
      settings.
    </p>
  </section>
</template>
