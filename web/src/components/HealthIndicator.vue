<script setup lang="ts">
/**
 * HealthIndicator: the header's compact integration health, linking to the Health screen: icon and label
 * ("Integrations healthy", "need attention", "not checked yet"), or the connection state when the server
 * cannot be read.
 *
 * Props:
 * - `health`: `OverviewV1.health`, or undefined while loading or unreachable.
 * - `connection`: `connected`, `connecting` or `unreachable`.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { HealthSummaryV1 } from '../../../src/server/api-types';
import { href } from '../router';
import { healthPresentation, textTone } from '../theme/status';

defineOptions({ name: 'HealthIndicator' });

defineProps<{ health: HealthSummaryV1 | undefined; connection: 'connected' | 'connecting' | 'unreachable' }>();
</script>

<template>
  <span
    v-if="connection === 'unreachable'"
    class="flex items-center gap-1 text-sm text-error"
    data-connection="unreachable"
  >
    <UIcon name="i-lucide-unplug" class="size-4" aria-hidden="true" /> Server not reachable
  </span>
  <span v-else-if="!health" class="text-sm text-muted" data-connection="connecting">Connecting…</span>
  <a
    v-else
    :href="href({ name: 'health' })"
    class="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
    :data-overall="health.overall"
  >
    <UIcon
      :name="healthPresentation[health.overall].icon"
      :class="['size-4', textTone[healthPresentation[health.overall].color]]"
      aria-hidden="true"
    />
    <span>{{ health.label }}</span>
    <span v-if="health.warnings.length" class="text-xs text-warning"
      >· {{ health.warnings.length }} warning{{ health.warnings.length === 1 ? '' : 's' }}</span
    >
  </a>
</template>
