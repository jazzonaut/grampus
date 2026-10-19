<script setup lang="ts">
/** Renders the server's task-wide allowance and its explicit measurement limits. */
import type { SpendingV1 } from '../../../src/server/api-types';
defineProps<{ spending: SpendingV1 }>();
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <section
    class="flex flex-col gap-2 rounded-xl border border-default bg-default p-4"
    data-panel="spending"
    :data-status="spending.status"
  >
    <h2 class="text-base font-semibold text-highlighted">Task spending allowance</h2>
    <p class="text-sm font-medium">{{ spending.statusLabel }}</p>
    <p class="text-sm">{{ spending.turnsLabel }}</p>
    <p class="text-sm">{{ spending.tokensLabel }}</p>
    <p class="text-sm text-muted">{{ spending.explanation }}</p>
    <slot />
    <details class="text-xs text-muted">
      <summary class="cursor-pointer">What counts</summary>
      <p class="mt-2">{{ spending.note }}</p>
    </details>
  </section>
</template>
