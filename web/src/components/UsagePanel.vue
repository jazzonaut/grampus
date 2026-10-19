<script setup lang="ts">
/**
 * UsagePanel: everything measured about a task's provider use (`UsageV1`): tokens and estimated cost per
 * provider and stage (UsageSummary), how complete each provider's figure is, turns, failed and stopped
 * turns and wall time per stage, repair attempts and human interventions. Unknown is never 0: a missing
 * measurement reads "Unknown", a lower bound is marked, and billed cost is always unknown.
 *
 * Props:
 * - `usage`: the server's `UsageV1`.
 */
import { computed } from 'vue';
import type { InterventionsV1, UsageCompleteness, UsageV1 } from '../../../src/server/api-types';
import UsageSummary from './UsageSummary.vue';
import { formatCount, formatDuration, localTime, plural } from './format';

defineOptions({ name: 'UsagePanel' });

const props = defineProps<{ usage: UsageV1 }>();

const completeness: Readonly<Record<UsageCompleteness, string>> = {
  complete: 'Complete',
  partial: 'Partial: a lower bound',
  live: 'Live: a turn is running',
  none: 'Nothing measured yet',
};

const interventionLabels: Readonly<Record<Exclude<keyof InterventionsV1, 'total'>, [string, string]>> = {
  answers: ['answer', 'answers'],
  authorizations: ['file authorization', 'file authorizations'],
  assessments: ['assessment', 'assessments'],
  retries: ['retry', 'retries'],
  rerunChecks: ['check rerun', 'check reruns'],
  recoveries: ['recovery', 'recoveries'],
  revisions: ['revision', 'revisions'],
  stops: ['stop or pause request', 'stop or pause requests'],
  approvals: ['approval', 'approvals'],
  guidance: ['guidance action', 'guidance actions'],
};

const interventions = computed(() =>
  (Object.keys(interventionLabels) as (keyof typeof interventionLabels)[])
    .filter(key => props.usage.interventions[key] > 0)
    .map(key => plural(props.usage.interventions[key], ...interventionLabels[key])),
);

function wall(ms: number | null, partial: boolean): string {
  if (ms === null) return 'Unknown';
  return `${formatDuration(ms)}${partial ? '+' : ''}`;
}
</script>

<template>
  <div class="flex flex-col gap-3" data-panel="usage">
    <UsageSummary :providers="usage.providers" :stages="usage.stages" :note="usage.note">
      <div v-if="usage.providers.length" class="overflow-x-auto">
        <table class="w-full text-sm">
          <caption class="pb-1 text-left text-xs font-medium tracking-wide text-muted uppercase">
            Coverage
          </caption>
          <thead>
            <tr class="border-b border-default text-left text-xs text-muted">
              <th scope="col" class="py-1 pr-3 font-medium">Provider</th>
              <th scope="col" class="py-1 pr-3 font-medium">Measurement</th>
              <th scope="col" class="py-1 pr-3 font-medium">Billed cost</th>
              <th scope="col" class="py-1 font-medium">Last observation</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in usage.providers" :key="row.provider" class="border-b border-muted last:border-0">
              <th scope="row" class="py-2 pr-3 text-left font-medium text-highlighted">{{ row.label }}</th>
              <td class="py-2 pr-3" :data-completeness="row.completeness">{{ completeness[row.completeness] }}</td>
              <td class="py-2 pr-3 text-muted italic">Unknown</td>
              <td class="py-2 text-muted">{{ localTime(row.updatedAt) || 'Unknown' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="usage.stages.length" class="overflow-x-auto">
        <table class="w-full text-sm">
          <caption class="pb-1 text-left text-xs font-medium tracking-wide text-muted uppercase">
            Turns by stage
          </caption>
          <thead>
            <tr class="border-b border-default text-left text-xs text-muted">
              <th scope="col" class="py-1 pr-3 font-medium">Stage</th>
              <th scope="col" class="py-1 pr-3 text-right font-medium">Turns</th>
              <th scope="col" class="py-1 pr-3 text-right font-medium">Failed</th>
              <th scope="col" class="py-1 pr-3 text-right font-medium">Stopped</th>
              <th scope="col" class="py-1 text-right font-medium">Wall time</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in usage.stages"
              :key="`${row.stage}:${row.provider}`"
              class="border-b border-muted last:border-0"
            >
              <th scope="row" class="py-2 pr-3 text-left font-medium text-highlighted">
                {{ row.label }} <span class="text-xs font-normal text-muted">{{ row.providerLabel }}</span>
              </th>
              <td class="py-2 pr-3 text-right tabular-nums">{{ row.turns }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ row.failedTurns }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ row.interruptedTurns }}</td>
              <td class="py-2 text-right tabular-nums" data-wall>{{ wall(row.wallMs, row.wallPartial) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-1 text-xs text-muted">A + marks a lower bound: turns still running are not counted.</p>
      </div>
      <p class="text-sm text-default" data-totals>
        {{ plural(usage.turns, 'turn')
        }}<template v-if="usage.unsettledTurns"> ({{ formatCount(usage.unsettledTurns) }} not settled)</template> ·
        {{ plural(usage.repairAttempts, 'repair attempt') }} ·
        {{ plural(usage.interventions.total, 'human intervention') }} after approval<template
          v-if="interventions.length"
        >
          ({{ interventions.join(', ') }})</template
        >
      </p>
    </UsageSummary>
  </div>
</template>
