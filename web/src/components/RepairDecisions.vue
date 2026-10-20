<script setup lang="ts">
/** Keeps the shared repair allowance and controller reasons visible during execution. */
import type { RepairsV1 } from '../../../src/server/api-types';
import { localTime } from './format';
defineProps<{ repairs: RepairsV1 }>();
</script>

<template>
  <section class="flex flex-col gap-2 rounded-xl border border-default bg-default p-4" data-panel="repairs">
    <h2 class="text-base font-semibold text-highlighted">Automatic repairs</h2>
    <p class="text-sm">
      Behavioural repairs: {{ repairs.used }} of {{ repairs.allowance }} allocated in this slice ·
      {{ repairs.remaining }} remaining
    </p>
    <p class="text-xs text-muted">
      Behavioural validation, review and acceptance share this allowance. A round is allocated when a repair is
      scheduled. See Usage for actual agent turns and measured consumption.
    </p>
    <p class="text-sm" data-readiness-budget>
      Readiness repairs: {{ repairs.readiness.used }} of {{ repairs.readiness.allowance }} allocated ·
      {{ repairs.readiness.remaining }} remaining · {{ repairs.readiness.checks }} approved checks
    </p>
    <p class="text-xs text-muted">
      Readiness covers declared formatting, lint and type checks. Both allowances survive retries and restarts; all
      attempts also count towards the task-wide spending limits.
    </p>
    <p v-if="!repairs.decisions.length" class="text-sm text-muted">No repair decision recorded for this slice.</p>
    <ol v-else class="flex flex-col gap-3" aria-label="Recent repair decisions">
      <li v-for="decision in repairs.decisions" :key="decision.sequence" class="border-t border-default pt-2">
        <p class="text-sm font-medium text-highlighted">
          {{ decision.title }} <span class="text-xs font-normal text-muted">· {{ localTime(decision.at) }}</span>
        </p>
        <p class="text-sm">{{ decision.reason }}</p>
        <p class="font-mono text-xs whitespace-pre-wrap">{{ decision.trigger }}</p>
        <p class="text-xs text-muted">{{ decision.progress }}</p>
        <p class="text-xs text-muted">{{ decision.budget }}</p>
        <p class="text-sm">{{ decision.outcome }}</p>
        <ul v-if="decision.results.length" class="list-disc pl-5 text-xs text-muted">
          <li v-for="(result, index) in decision.results" :key="index">{{ result.name }}: {{ result.outcome }}</li>
        </ul>
        <details class="text-xs text-muted">
          <summary class="cursor-pointer">Evidence identity</summary>
          <p class="font-mono break-all">
            Result {{ decision.resultId }} · artifact {{ decision.artifact ?? 'Unknown' }}
          </p>
          <p v-for="(result, index) in decision.results" :key="index" class="font-mono break-all">
            {{ result.name }} · artifact {{ result.artifact ?? 'Unknown' }}
          </p>
        </details>
      </li>
    </ol>
  </section>
</template>
