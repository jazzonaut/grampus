<script setup lang="ts">
// Owns comparison navigation; each detail screen supplies controller-derived state and actions.
import type { ComparisonSummaryV1 } from '../../../src/server/api-types';
import { get } from '../api/client';
import { usePolled } from '../api/usePolled';
import { pollIntervalMs } from '../settings';
const comparisons = usePolled(() => get<ComparisonSummaryV1[]>('/api/v1/comparisons'), pollIntervalMs);
</script>

<template>
  <div class="grampus-page">
    <h1 class="text-3xl font-semibold">Comparisons</h1>
    <p>
      Open a task and choose <strong>Compare model profiles on this plan</strong> to prepare a shared-plan comparison.
    </p>
    <p v-if="comparisons.error.value" role="alert">{{ comparisons.error.value.message }}</p>
    <a
      v-for="item in comparisons.data.value ?? []"
      :key="item.id"
      :href="`#/comparisons/${item.id}`"
      class="grampus-surface hover:underline"
      ><strong>{{ item.name }}</strong
      ><span class="ml-3 text-muted">{{ item.status }}</span></a
    >
  </div>
</template>
