<script setup lang="ts">
/** Shows the server's disjoint workflow intervals, including live work, waits and recovery. */
import type { UsageV1 } from '../../../src/server/api-types';
import { formatDuration } from './format';
defineProps<{ timing: NonNullable<UsageV1['workflow']> }>();
</script>

<template>
  <section class="overflow-x-auto" data-workflow-timing>
    <p class="text-sm font-medium">
      Total elapsed: {{ timing.elapsedMs === null ? 'Unknown' : formatDuration(timing.elapsedMs) }}
      <span v-if="timing.live"> (live)</span>
    </p>
    <p class="text-xs text-muted">
      Active {{ formatDuration(timing.activeMs) }} · Waiting {{ formatDuration(timing.waitingMs) }} · Recovery
      {{ formatDuration(timing.recoveryMs) }}. Includes checks and setup; nested operations are counted once.
    </p>
    <p v-if="timing.clockAdjusted" class="text-xs text-muted">Clock adjustment observed; times are lower bounds.</p>
    <table class="w-full text-sm">
      <caption class="text-left">
        Workflow steps
      </caption>
      <thead>
        <tr class="text-left">
          <th>Step</th>
          <th>Executions</th>
          <th>Active</th>
          <th>Waiting</th>
          <th>Recovery</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in timing.stages" :key="row.stage">
          <th class="text-left font-medium">{{ row.stage }}</th>
          <td>{{ row.steps }}</td>
          <td>{{ formatDuration(row.activeMs) }}</td>
          <td>{{ formatDuration(row.waitingMs) }}</td>
          <td>{{ formatDuration(row.recoveryMs) }}</td>
        </tr>
      </tbody>
    </table>
    <details v-if="timing.steps.length" class="mt-2">
      <summary class="text-xs">Every execution, including retries</summary>
      <table class="w-full text-xs">
        <thead>
          <tr class="text-left">
            <th>Slice</th>
            <th>Step</th>
            <th>Active</th>
            <th>Waiting</th>
            <th>Recovery</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="step in timing.steps" :key="`${step.stage}:${step.sequence}`">
            <td>{{ step.sliceIndex + 1 }}</td>
            <td>{{ step.stage }}</td>
            <td>{{ formatDuration(step.activeMs) }}</td>
            <td>{{ formatDuration(step.waitingMs) }}</td>
            <td>{{ formatDuration(step.recoveryMs) }}</td>
            <td>{{ step.finishedAt ? 'Settled' : 'Pending' }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </section>
</template>
