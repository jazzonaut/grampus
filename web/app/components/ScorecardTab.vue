<!--
  The scorecard: per-dispatch model, time and tokens, totals and the human cost. Unknown values show as
  "?", never as zero. A running task's scorecard is measured on request and marked provisional.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ScorecardView } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { count, duration, money } from '../presentation';

const props = defineProps<{ taskId: string; finished: boolean }>();

const card = ref<ScorecardView | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    card.value = await getJson<ScorecardView>(`/api/tasks/${encodeURIComponent(props.taskId)}/scorecard`);
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    loading.value = false;
  }
}
// Measuring reads transcripts, so it runs when the tab opens and when the task finishes, not on every change.
watch(() => [props.taskId, props.finished], load, { immediate: true });

const tiles = computed(() => {
  const value = card.value;
  if (!value) return [];
  const usage = value.totals.usage;
  return [
    {
      label: value.outcome === 'running' ? 'Wall time so far' : 'Wall time',
      value: duration(value.wallMs),
      icon: 'i-lucide-clock',
    },
    { label: 'Agent time', value: duration(value.totals.agentMs), icon: 'i-lucide-bot' },
    { label: 'First verified result', value: duration(value.delivery.firstVerifiedMs), icon: 'i-lucide-clock' },
    { label: 'Awaiting selection', value: duration(value.delivery.selectionWaitMs), icon: 'i-lucide-hourglass' },
    {
      label: 'External interventions',
      value: String(value.delivery.externalInterventions),
      icon: 'i-lucide-user-check',
    },
    { label: 'Automatic recoveries', value: String(value.delivery.automaticRecoveries), icon: 'i-lucide-refresh-cw' },
    { label: 'Input tokens', value: count(usage?.input), icon: 'i-lucide-arrow-down-to-line' },
    { label: 'Cached input', value: count(usage?.cachedInput), icon: 'i-lucide-database' },
    { label: 'Output tokens', value: count(usage?.output), icon: 'i-lucide-arrow-up-from-line' },
    { label: 'Estimated cost', value: money(value.totals.costUsd), icon: 'i-lucide-receipt' },
    {
      label: 'Your decisions',
      value: String(value.human.decisions + value.human.answers),
      icon: 'i-lucide-user-check',
    },
    { label: 'Waited for you', value: duration(value.human.waitingMs), icon: 'i-lucide-hourglass' },
  ];
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <UBadge v-if="card && !card.final" color="warning" variant="subtle" icon="i-lucide-construction"
        >Provisional</UBadge
      >
      <span v-if="card" class="text-sm text-muted">{{ card.outcome }} · recipe {{ card.recipe }}</span>
      <UButton
        class="ml-auto"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="loading"
        label="Measure again"
        @click="load"
      />
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div v-if="!card && loading" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <USkeleton v-for="n in 8" :key="n" class="h-20" />
    </div>
    <template v-if="card">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div v-for="tile in tiles" :key="tile.label" class="rounded-lg border border-default p-3">
          <p class="text-xs text-muted flex items-center gap-1.5">
            <UIcon :name="tile.icon" class="size-3.5" /> {{ tile.label }}
          </p>
          <p class="text-xl font-semibold tabular-nums mt-1">{{ tile.value }}</p>
        </div>
      </div>
      <p v-if="card.totals.dispatchesWithUnknownUsage" class="text-sm text-warning">
        Token usage is unknown for {{ card.totals.dispatchesWithUnknownUsage }} dispatch{{
          card.totals.dispatchesWithUnknownUsage === 1 ? '' : 'es'
        }}; totals cover the rest.
      </p>

      <details class="rounded-lg border border-default p-3">
        <summary class="cursor-pointer text-sm font-medium">
          Worker breakdown · {{ card.dispatches.length }} dispatches
        </summary>
        <div class="overflow-x-auto mt-3">
          <table class="w-full text-sm">
            <thead class="bg-elevated/50 text-xs text-muted">
              <tr>
                <th class="px-3 py-2 text-left font-medium">Stage</th>
                <th class="px-3 py-2 text-left font-medium">Agent</th>
                <th class="px-3 py-2 text-left font-medium">Model</th>
                <th class="px-3 py-2 text-left font-medium">Effort</th>
                <th class="px-3 py-2 text-right font-medium">Working</th>
                <th class="px-3 py-2 text-right font-medium">Waited</th>
                <th class="px-3 py-2 text-right font-medium">Input</th>
                <th class="px-3 py-2 text-right font-medium">Cached</th>
                <th class="px-3 py-2 text-right font-medium">Output</th>
                <th class="px-3 py-2 text-right font-medium">Est. cost</th>
                <th class="px-3 py-2 text-left font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="item in card.dispatches" :key="item.dispatchId">
                <td class="px-3 py-2 font-mono text-xs">{{ item.key }}</td>
                <td class="px-3 py-2">{{ item.provider ?? item.agent ?? '?' }}</td>
                <td class="px-3 py-2 font-mono text-xs">{{ item.models.join(', ') || '?' }}</td>
                <td class="px-3 py-2">{{ item.effort ?? '-' }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ duration(item.agentMs ?? item.durationMs) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ item.waitingMs ? duration(item.waitingMs) : '-' }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ count(item.usage?.input) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ count(item.usage?.cachedInput) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ count(item.usage?.output) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <UTooltip v-if="item.costNote" :text="item.costNote">
                    <span class="underline decoration-dotted">?</span>
                  </UTooltip>
                  <span v-else>{{ money(item.costUsd) }}</span>
                </td>
                <td class="px-3 py-2">
                  <UTooltip v-if="item.note" :text="item.note">
                    <span class="underline decoration-dotted">{{ item.outcome ?? 'unsettled' }}</span>
                  </UTooltip>
                  <span v-else>{{ item.outcome ?? 'unsettled' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
      <details class="rounded-lg border border-default p-3">
        <summary class="cursor-pointer text-sm font-medium">Work by phase and measurement notes</summary>
        <div class="space-y-3 mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <caption class="text-left font-medium">
              Work by phase (summed work, not elapsed time)
            </caption>
            <thead>
              <tr>
                <th class="text-left">Phase</th>
                <th>Agent time</th>
                <th>Check time</th>
                <th>Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="phase in card.phases" :key="phase.phase">
                <td>{{ phase.phase }}</td>
                <td class="text-center">{{ duration(phase.agentMs) }}{{ phase.unknownTime ? ' + unknown' : '' }}</td>
                <td class="text-center">{{ duration(phase.checkMs) }}</td>
                <td class="text-center">{{ money(phase.costUsd) }}{{ phase.unknownCost ? ' + unknown' : '' }}</td>
              </tr>
            </tbody>
          </table>
          <p class="text-sm text-muted">
            Corrections: {{ card.interventions.implementation }} implementation,
            {{ card.interventions.workflow }} workflow, {{ card.interventions.unknown }} unclassified.
          </p>
          <p class="text-xs text-muted">
            Human cost: {{ card.human.decisions }} decisions and {{ card.human.answers }} answers,
            {{ card.human.fromChat }} from chat. Input counts uncached tokens; cached input is listed separately. Cost
            is estimated at API list prices (modelPrices in config.json); subscription use is not billed per token.
          </p>
        </div>
      </details>
    </template>
  </div>
</template>
