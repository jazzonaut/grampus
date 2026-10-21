<script setup lang="ts">
// Owns scorecard presentation; all counters and completeness come from the server.
import type { RunMetricsV1 } from '../../../src/server/api-types';
import { formatTokens, formatDuration } from './format';
defineProps<{ metrics: RunMetricsV1 }>();
</script>

<template>
  <section class="grampus-surface">
    <h2 class="text-lg font-semibold">Run metrics</h2>
    <dl class="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      <div>
        <dt class="text-muted">Agent time</dt>
        <dd>
          {{ metrics.agentMs === null ? 'Unknown' : formatDuration(metrics.agentMs)
          }}{{ metrics.agentTimePartial ? ' (partial)' : '' }}
        </dd>
      </div>
      <div>
        <dt class="text-muted">Elapsed to delivery</dt>
        <dd>{{ metrics.elapsedMs === null ? 'Not completed' : formatDuration(metrics.elapsedMs) }}</dd>
      </div>
      <div>
        <dt class="text-muted">Repair attempts</dt>
        <dd>{{ metrics.repairAttempts }}</dd>
      </div>
      <div>
        <dt class="text-muted">Workflow execution</dt>
        <dd>{{ metrics.workflowActiveMs === null ? 'Unknown' : formatDuration(metrics.workflowActiveMs) }}</dd>
      </div>
      <div>
        <dt class="text-muted">Waiting</dt>
        <dd>
          {{ metrics.waitingMs === null ? 'Unknown' : formatDuration(metrics.waitingMs)
          }}{{ metrics.timingPartial ? ' (so far)' : '' }}
        </dd>
      </div>
      <div>
        <dt class="text-muted">Human interventions</dt>
        <dd>{{ metrics.interventions.total }}</dd>
      </div>
      <div>
        <dt class="text-muted">Provider tokens</dt>
        <dd>{{ formatTokens(metrics.usage.headline.tokens) }} · {{ metrics.usage.headline.completeness }}</dd>
      </div>
      <div>
        <dt class="text-muted">Subscription rejections</dt>
        <dd>{{ metrics.subscription.rejectedTurns ?? 'Unknown' }}</dd>
      </div>
      <div>
        <dt class="text-muted">Delivery</dt>
        <dd>{{ metrics.verifiedDelivery ? 'Verified locally' : metrics.status }}</dd>
      </div>
    </dl>
    <details v-if="metrics.executionPhases.length" class="mt-4 text-sm">
      <summary class="cursor-pointer font-medium">Execution phases</summary>
      <p class="mt-2 text-xs text-muted">Observed totals overlap. Do not add them to workflow elapsed time.</p>
      <table class="mt-2 w-full text-left text-xs">
        <thead>
          <tr>
            <th class="p-2">Phase</th>
            <th class="p-2">Time</th>
            <th class="p-2">Observations</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in metrics.executionPhases" :key="row.phase" class="border-t border-default">
            <td class="p-2">{{ row.label }}</td>
            <td class="p-2">{{ formatDuration(row.elapsedMs) }}</td>
            <td class="p-2">{{ row.observations }}</td>
          </tr>
        </tbody>
      </table>
    </details>
    <div v-if="metrics.models.length" class="mt-4 overflow-auto">
      <table class="w-full text-left text-xs">
        <thead>
          <tr>
            <th class="p-2">Role</th>
            <th class="p-2">Provider</th>
            <th class="p-2">Requested / observed model</th>
            <th class="p-2">Effort</th>
            <th class="p-2">Turns</th>
            <th class="p-2">Input / output tokens</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in metrics.models" :key="index" class="border-t border-default">
            <td class="p-2">{{ row.stage }}</td>
            <td class="p-2">{{ row.provider }}</td>
            <td class="p-2">{{ row.requestedModel ?? 'Provider default' }} / {{ row.model ?? 'Unknown' }}</td>
            <td class="p-2">{{ row.effort ?? 'Default' }}</td>
            <td class="p-2">{{ row.turns }}</td>
            <td class="p-2">
              {{ formatTokens(row.inputTokens) }} / {{ formatTokens(row.outputTokens)
              }}{{
                row.incomplete.includes('inputTokens') || row.incomplete.includes('outputTokens') ? ' (partial)' : ''
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="mt-3 text-xs text-muted">
      Token counts do not measure subscription allowance consumed. Time includes provider and tool work. Missing
      measurements remain unknown.
    </p>
  </section>
</template>
