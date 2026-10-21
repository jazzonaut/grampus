<script setup lang="ts">
/** Shows display-only working tree observations while this task is visible, independently of evidence. */
import { computed, ref, watch } from 'vue';
import type { LiveChangesV1 } from '../../../src/server/api-types';
import { get, needsAccessLink } from '../api/client';
import { usePolled } from '../api/usePolled';
import { localTime, short } from './format';

const props = defineProps<{ path: string; intervalMs: number; compact?: boolean }>();
defineEmits<{ inspect: [] }>();
const selected = ref<string | null>(null);
const live = usePolled(
  () => get<LiveChangesV1>(props.path + (selected.value === null ? '' : `?path=${encodeURIComponent(selected.value)}`)),
  props.intervalMs,
  { enabled: () => !needsAccessLink.value },
);
const observation = computed(() => live.data.value);
const patch = computed(() => observation.value?.selected);
const lines = computed(() => patch.value?.patch.split('\n') ?? []);

watch(observation, value => {
  if (selected.value && value && !value.paths.includes(selected.value)) selected.value = null;
});

function choose(path: string): void {
  selected.value = path;
  void live.refresh().then(() => {
    // A click during polling joins that read; fetch the newly selected file after it settles.
    if (selected.value === path && observation.value?.selected?.path !== path) void live.refresh();
  });
}
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-default bg-default p-4" data-panel="live-changes">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-highlighted">{{ compact ? 'Changes so far' : 'Live changes' }}</h2>
      <button
        v-if="!compact"
        type="button"
        class="grampus-link-button"
        :disabled="live.loading.value"
        @click="live.refresh()"
      >
        Refresh changes
      </button>
    </div>
    <p class="text-xs text-muted">
      Observed working files since the task base. These can change during a read and have not been verified.
    </p>
    <p v-if="live.error.value" role="alert" class="text-sm text-error">
      Live changes unavailable: {{ live.error.value.message }}. Any changes below are from the last successful read.
    </p>
    <p v-if="!observation && !live.error.value" class="text-sm text-muted">Reading working files…</p>
    <template v-if="observation">
      <p class="text-xs text-muted">
        Observed {{ localTime(observation.observedAt) }} · base {{ short(observation.base) }} ·
        {{ observation.total }} changed files
      </p>
      <p v-if="observation.truncated" class="text-sm text-warning">
        Showing {{ observation.paths.length }} of {{ observation.total }} changed files.
      </p>
      <p v-if="!observation.paths.length" class="text-sm text-muted">No changed files observed.</p>
      <ul v-else-if="compact" class="max-h-40 overflow-auto font-mono text-xs" aria-label="Observed changed files">
        <li v-for="file in observation.paths" :key="file" class="py-1 break-all">{{ file }}</li>
      </ul>
      <div v-else class="grid gap-3 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
        <ul class="flex max-h-96 flex-col gap-1 overflow-auto" aria-label="Files changed since the task base">
          <li v-for="file in observation.paths" :key="file">
            <button
              type="button"
              class="w-full rounded border border-default px-2 py-1 text-left font-mono text-xs break-all hover:bg-muted aria-pressed:bg-elevated"
              :aria-pressed="selected === file"
              @click="choose(file)"
            >
              {{ file }}
            </button>
          </li>
        </ul>
        <div class="min-w-0">
          <p v-if="!patch" class="text-sm text-muted">Choose a file to follow its live diff.</p>
          <template v-else>
            <p class="mb-2 font-mono text-xs break-all">{{ patch.path }}</p>
            <p v-if="patch.truncated" class="text-sm text-warning">
              Diff preview truncated. Inspect the full file in the workspace.
            </p>
            <pre
              class="grampus-code max-h-96"
              tabindex="0"
              :aria-label="`${patch.path} live diff`"
            ><span v-for="(line, index) in lines" :key="index" class="block min-h-[1em]" :class="{ 'text-success': line.startsWith('+'), 'text-error': line.startsWith('-') }">{{ line }}</span></pre>
          </template>
        </div>
      </div>
    </template>
    <button
      v-if="compact"
      type="button"
      class="self-start text-sm text-primary hover:underline"
      @click="$emit('inspect')"
    >
      Browse changes →
    </button>
  </section>
</template>
