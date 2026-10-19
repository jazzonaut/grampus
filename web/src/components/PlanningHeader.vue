<script setup lang="ts">
/** Owns the planning title and recorded session facts, shared by conversation and proposal views. */
import { computed } from 'vue';
import type { KickoffDetailV1 } from '../../../src/server/api-types';
import { useNow } from '../announcer';
import StatusBadge from './StatusBadge.vue';
import UsageHeadline from './UsageHeadline.vue';
import { elapsedSince, formatDuration, short } from './format';
const props = defineProps<{ kickoff: KickoffDetailV1 }>();
const timing = computed(() => props.kickoff.usage.stages.find(stage => stage.stage === 'planning'));
const now = useNow();
</script>

<template>
  <header class="flex flex-col gap-5">
    <div>
      <p class="mb-2 text-xs font-medium tracking-wide text-primary uppercase">Planning conversation</p>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-3xl font-semibold tracking-tight text-highlighted">{{ kickoff.title }}</h1>
        <StatusBadge :status="kickoff.status" :label="kickoff.statusLabel" />
      </div>
      <p class="mt-2 text-sm text-toned" data-explanation>{{ kickoff.explanation }}</p>
    </div>
    <div class="grampus-stat-strip">
      <div>
        <p class="text-xs text-muted">Repository</p>
        <p class="mt-1 font-semibold text-highlighted">{{ kickoff.repository.name }}</p>
        <p class="mt-1 font-mono text-xs text-muted" :title="kickoff.base">{{ short(kickoff.base) }}</p>
      </div>
      <div>
        <p class="text-xs text-muted">Planner</p>
        <p class="mt-1 font-semibold text-highlighted">{{ kickoff.provider.label }}</p>
        <p class="mt-1 text-xs text-muted">
          {{ kickoff.provider.model ?? 'Provider default model'
          }}<template v-if="kickoff.activity?.startedAt">
            · {{ elapsedSince(kickoff.activity.startedAt, now) }} elapsed this turn</template
          ><template v-else-if="timing?.wallMs != null">
            · {{ formatDuration(timing.wallMs) }}{{ timing.wallPartial ? '+' : '' }} recorded provider time
          </template>
        </p>
      </div>
      <div>
        <p class="text-xs text-muted">Open questions</p>
        <p class="mt-1 font-semibold text-highlighted">{{ kickoff.questions.length }}</p>
        <p class="mt-1 text-xs text-muted">{{ kickoff.questions.length ? 'Needs your input' : kickoff.statusLabel }}</p>
      </div>
      <UsageHeadline :usage="kickoff.usage.headline" />
    </div>
  </header>
</template>
