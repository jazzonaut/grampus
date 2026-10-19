<script setup lang="ts">
/**
 * HealthSummaryBar: overall integration health with its reason and each integration's status in words,
 * linking to the Health screen. Health is informational and never a gate.
 *
 * Props:
 * - `health`: `OverviewV1.health`.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { HealthSummaryV1 } from '../../../src/server/api-types';
import { href } from '../router';
import { healthPresentation, integrationPresentation, textTone } from '../theme/status';

defineOptions({ name: 'HealthSummaryBar' });

defineProps<{ health: HealthSummaryV1 }>();
</script>

<template>
  <section
    aria-labelledby="health-summary-heading"
    class="flex flex-col gap-2 rounded-lg border border-default p-4"
    data-panel="health-summary"
  >
    <div class="flex flex-wrap items-center gap-2">
      <UIcon
        :name="healthPresentation[health.overall].icon"
        :class="['size-5', textTone[healthPresentation[health.overall].color]]"
        aria-hidden="true"
      />
      <h2 id="health-summary-heading" class="font-semibold text-highlighted">{{ health.label }}</h2>
      <a :href="href({ name: 'health' })" class="ml-auto text-sm text-primary underline-offset-2 hover:underline"
        >View health</a
      >
    </div>
    <p class="text-sm text-toned">{{ health.reason }}<template v-if="health.stale"> Due for a new check.</template></p>
    <ul v-if="health.warnings.length" class="list-disc pl-5 text-sm text-warning">
      <li v-for="warning in health.warnings" :key="warning">{{ warning }}</li>
    </ul>
    <ul v-if="health.integrations.length" class="flex flex-wrap gap-2 text-xs" aria-label="Integrations">
      <li
        v-for="integration in health.integrations"
        :key="integration.id"
        class="flex items-center gap-1 rounded-md border border-default px-2 py-1"
        :data-status="integration.status"
      >
        <UIcon :name="integrationPresentation[integration.status].icon" class="size-3.5" aria-hidden="true" />
        <span class="font-medium">{{ integration.label }}</span>
        <span class="text-muted">{{ integration.statusLabel }}</span>
      </li>
    </ul>
  </section>
</template>
