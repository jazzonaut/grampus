<script setup lang="ts">
// Owns observability navigation and replay controls; graph state folds server-decided event updates.
import { computed, onScopeDispose, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { ActivityEventV1, ActivitySubjectV1 } from '../../../src/server/api-types';
import { useObservability } from '../observability/useObservability';
import { graphFrame, usageSnapshots } from '../observability/graph';
import { clockTickMs } from '../settings';
import { href } from '../router';
import ExecutionGraph from '../components/ExecutionGraph.vue';
import ActivityTimeline from '../components/ActivityTimeline.vue';
import ActivityInspector from '../components/ActivityInspector.vue';
import { localTime } from '../components/format';

const props = defineProps<ActivitySubjectV1>();
const activity = useObservability(() => props);
const parent = computed(() => ({ name: props.kind, id: props.id }));
const cursor = ref<string | null>(null);
const selected = ref<string | null>(null);
const participant = ref<string | null>(null);
const search = ref('');
const category = ref('all');
const playing = ref(false);
const index = computed(() =>
  cursor.value === null
    ? activity.events.value.length - 1
    : activity.events.value.findIndex(event => event.id === cursor.value),
);
const prefix = computed(() => activity.events.value.slice(0, index.value + 1));
const frame = computed(() => graphFrame(activity.nodes.value, prefix.value, activity.live.value));
const inspected = computed(() => prefix.value.find(event => event.id === selected.value));
const related = computed(() => {
  const event = inspected.value;
  if (!event) return [];
  return prefix.value.filter(
    item =>
      item.id !== event.id &&
      item.correlation.sessionId === event.correlation.sessionId &&
      (event.correlation.itemId
        ? item.correlation.itemId === event.correlation.itemId
        : event.correlation.runId
          ? item.correlation.runId === event.correlation.runId
          : item.correlation.resultId !== null && item.correlation.resultId === event.correlation.resultId),
  );
});
const filtered = computed(() =>
  prefix.value
    .filter(
      event =>
        (category.value === 'all' || event.category === category.value) &&
        (!participant.value || event.source === participant.value || event.target === participant.value) &&
        `${event.label} ${event.type} ${event.source} ${event.target}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
    )
    .reverse(),
);
const usage = computed(() => usageSnapshots(prefix.value));
const tokens = (field: 'input' | 'output' | 'cached') => {
  const values = usage.value.map(item => item[field]);
  return values.length && values.every(value => value !== null)
    ? values.reduce<number>((sum, value) => sum + value, 0).toLocaleString()
    : 'Unavailable';
};

function seek(position: number): void {
  activity.live.value = false;
  cursor.value = activity.events.value[position]?.id ?? null;
}
function choose(id: string): void {
  selected.value = id;
}
function chooseParticipant(id: string): void {
  participant.value = id;
  selected.value = [...prefix.value].reverse().find(event => event.source === id || event.target === id)?.id ?? null;
}
function resume(): void {
  playing.value = false;
  cursor.value = null;
  activity.live.value = true;
}
function scrub(event: Event): void {
  if (event.target instanceof HTMLInputElement) seek(Number(event.target.value));
}
let timer: ReturnType<typeof setInterval> | undefined;
watch(playing, value => {
  if (timer) clearInterval(timer);
  if (!value) return;
  activity.live.value = false;
  if (index.value >= activity.events.value.length - 1) seek(0);
  timer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (index.value >= activity.events.value.length - 1) playing.value = false;
    else seek(index.value + 1);
  }, clockTickMs);
});
onScopeDispose(() => {
  if (timer) clearInterval(timer);
});
const categories: ActivityEventV1['category'][] = [
  'controller',
  'model',
  'tool',
  'review',
  'validation',
  'delivery',
  'failure',
];
</script>

<template>
  <div class="grampus-page">
    <a :href="href(parent)" class="self-start text-sm text-primary hover:underline"
      >← Back to {{ kind === 'task' ? 'task' : 'planning' }}</a
    >
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-highlighted">Agent observability</h1>
        <p class="text-sm text-muted">Communication, activity and recorded controller decisions.</p>
      </div>
      <UBadge
        :color="activity.live.value ? 'primary' : 'neutral'"
        variant="subtle"
        :label="activity.live.value ? 'Live' : 'Historical replay'"
      />
    </div>
    <p v-if="activity.poll.error.value" role="alert" class="text-error">
      Activity unavailable: {{ activity.poll.error.value.message }}. The retained view may be stale.
    </p>
    <p v-if="activity.historyError.value" role="alert" class="text-error">{{ activity.historyError.value }}</p>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="rounded-xl border border-default p-3">
        <p class="text-xs text-muted">Input tokens observed</p>
        <strong>{{ tokens('input') }}</strong>
      </div>
      <div class="rounded-xl border border-default p-3">
        <p class="text-xs text-muted">Output tokens observed</p>
        <strong>{{ tokens('output') }}</strong>
      </div>
      <div class="rounded-xl border border-default p-3">
        <p class="text-xs text-muted">Cache reads observed</p>
        <strong>{{ tokens('cached') }}</strong>
      </div>
      <div class="rounded-xl border border-default p-3">
        <p class="text-xs text-muted">Events in replay prefix</p>
        <strong>{{ prefix.length }}</strong>
      </div>
    </div>
    <p class="text-xs text-muted">
      Usage shows the latest cumulative snapshot per session in this window, not per-call costs. Missing sessions and
      measurements are not zero.
    </p>
    <section class="flex flex-col gap-3 rounded-xl border border-default p-4" aria-label="Historical replay controls">
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-step-back"
          label="Previous event"
          :disabled="index <= 0"
          @click="seek(index - 1)"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
          :label="playing ? 'Pause replay' : 'Play replay'"
          :disabled="!activity.events.value.length"
          @click="playing = !playing"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-step-forward"
          label="Next event"
          :disabled="index >= activity.events.value.length - 1"
          @click="seek(index + 1)"
        />
        <UButton color="primary" variant="soft" size="sm" label="Return to live" @click="resume" />
        <UButton
          v-if="activity.before.value"
          color="neutral"
          variant="outline"
          size="sm"
          label="Load earlier events"
          :loading="activity.loadingHistory.value"
          @click="activity.loadOlder()"
        />
      </div>
      <label class="text-xs text-muted"
        >Replay position · {{ index + 1 }} / {{ activity.events.value.length }} ·
        {{ prefix.at(-1) ? localTime(prefix.at(-1)!.at) : 'No events'
        }}<input
          type="range"
          min="0"
          :max="Math.max(0, activity.events.value.length - 1)"
          :value="index"
          class="mt-2 w-full accent-current"
          aria-label="Replay position"
          @input="scrub"
      /></label>
    </section>
    <div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,1fr)]">
      <div class="flex min-w-0 flex-col gap-4">
        <section class="rounded-xl border border-default p-3">
          <ExecutionGraph
            :nodes="frame.nodes"
            :edges="frame.edges"
            :live="activity.live.value && !activity.poll.error.value"
            @select="chooseParticipant"
          />
        </section>
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-xs"
            >Filter
            <select v-model="category" class="rounded border border-default bg-default p-2">
              <option value="all">All events</option>
              <option v-for="value in categories" :key="value" :value="value">{{ value }}</option>
            </select></label
          >
          <label class="text-xs"
            >Search
            <input
              v-model="search"
              type="search"
              class="rounded border border-default bg-default p-2"
              placeholder="Search activity"
          /></label>
          <UButton
            v-if="participant"
            color="neutral"
            variant="ghost"
            size="sm"
            label="Clear participant filter"
            @click="participant = null"
          />
        </div>
        <ActivityTimeline :events="filtered" :selected="selected" :nodes="frame.nodes" @select="choose" />
      </div>
      <ActivityInspector :event="inspected" :related="related" @select="choose" />
    </div>
    <details class="rounded-xl border border-default p-4">
      <summary class="cursor-pointer text-sm font-medium">Telemetry coverage and limitations</summary>
      <ul class="mt-3 list-disc space-y-2 pl-5 text-xs text-muted">
        <li v-for="note in activity.poll.data.value?.coverage" :key="note">{{ note }}</li>
      </ul>
    </details>
  </div>
</template>
