<script setup lang="ts">
/**
 * ActivityCard: what is running now (`ActivityV1`), for a task or a planning conversation. Only what is
 * known is shown: no percentages. Agent requests describe what was asked for, not results.
 *
 * Props:
 * - `activity`: the server's activity.
 * - `heading`: the accessible name of the card, default "Current activity".
 *
 * Slots:
 * - `actions`: e.g. Stop now.
 */
import { computed, useId } from 'vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { ActivityV1 } from '../../../src/server/api-types';
import { useNow } from '../announcer';
import { elapsedSince, plural } from './format';

defineOptions({ name: 'ActivityCard' });

const props = withDefaults(defineProps<{ activity: ActivityV1; heading?: string }>(), { heading: 'Current activity' });

const slots = defineSlots<{ actions?: () => unknown }>();

const now = useNow();
const headingId = useId();

const actors: Readonly<Record<ActivityV1['actor'], string>> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  arbitrator: 'Arbitrator',
  check: 'Check',
  controller: 'Grampus',
};

const counts = computed(() => {
  const { repositoryCalls, integrationCalls, fileRequests } = props.activity;
  return [
    repositoryCalls === null ? null : plural(repositoryCalls, 'repository action'),
    integrationCalls === null ? null : plural(integrationCalls, 'MCP request'),
    fileRequests === null ? null : plural(fileRequests, 'file change request'),
  ].filter((item): item is string => item !== null);
});
</script>

<template>
  <section
    :aria-labelledby="headingId"
    class="flex flex-col gap-2 rounded-lg border border-info/40 bg-info/5 p-4"
    data-panel="activity"
  >
    <h2 :id="headingId" class="sr-only">{{ heading }}</h2>
    <div class="flex flex-wrap items-center gap-2">
      <UIcon name="i-lucide-loader-circle" class="size-4 text-info motion-safe:animate-spin" aria-hidden="true" />
      <strong class="text-highlighted">{{ activity.title }}</strong>
      <span class="text-xs text-muted">
        {{ actors[activity.actor] }}<template v-if="activity.provider"> · {{ activity.provider.label }}</template>
      </span>
      <span v-if="activity.startedAt" class="ml-auto text-xs text-muted tabular-nums">
        Elapsed {{ elapsedSince(activity.startedAt, now) }}
      </span>
    </div>
    <p class="text-sm text-default">{{ activity.description }}</p>
    <p v-if="counts.length" class="text-xs text-muted">{{ counts.join(' · ') }}</p>
    <ul
      v-if="activity.recent.length"
      class="flex flex-col gap-0.5 font-mono text-xs text-toned"
      aria-label="Recent agent requests"
    >
      <li v-for="(item, index) in activity.recent" :key="index">{{ item }}</li>
    </ul>
    <p v-if="activity.lastActivityAt" class="text-xs text-muted">
      Last activity {{ elapsedSince(activity.lastActivityAt, now) }} ago. You can leave this page; progress is saved
      locally.
    </p>
    <div v-if="slots.actions" class="flex flex-wrap gap-2"><slot name="actions" /></div>
  </section>
</template>
