<script setup lang="ts">
/** Owns overview counts drawn directly from the returned lists and runner pool, without estimates. */
import type { OverviewV1 } from '../../../src/server/api-types';
import SectionHeading from './SectionHeading.vue';
defineProps<{ overview: OverviewV1 }>();
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <section class="grampus-surface">
      <SectionHeading title="Runner slots" icon="i-lucide-play" />
      <p class="text-3xl font-semibold text-highlighted">
        {{ overview.pool.running }} <span class="text-sm font-normal text-muted">/ {{ overview.pool.limit }}</span>
      </p>
      <p class="mt-2 text-xs text-muted">Occupied, including retained recovery owners</p>
    </section>
    <section class="grampus-surface">
      <SectionHeading title="Needs attention" icon="i-lucide-circle-help" />
      <p class="text-3xl font-semibold text-highlighted">{{ overview.attention.length }}</p>
      <p class="mt-2 text-xs text-muted">Recorded decisions and blockers</p>
    </section>
    <section class="grampus-surface">
      <SectionHeading title="Planning" icon="i-lucide-messages-square" />
      <p class="text-3xl font-semibold text-highlighted">{{ overview.planning.length }}</p>
      <p class="mt-2 text-xs text-muted">Conversations before task creation</p>
    </section>
    <section class="grampus-surface">
      <SectionHeading title="Recent deliveries" icon="i-lucide-check-check" />
      <p class="text-3xl font-semibold text-highlighted">{{ overview.recentDeliveries.length }}</p>
      <p class="mt-2 text-xs text-muted">Latest verified local deliveries shown below</p>
    </section>
  </div>
</template>
