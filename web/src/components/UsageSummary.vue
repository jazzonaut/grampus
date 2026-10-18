<script setup lang="ts">
/**
 * UsageSummary: measured tokens and estimated cost, per provider and per workflow stage.
 *
 * Unknown is never shown as zero. A `null` measurement reads "Unknown"; a value that is a
 * lower bound because some observations are missing carries a visible "partial" mark; cost
 * is always labelled an estimate, and billed cost is stated as unknown.
 *
 * Props:
 * - `providers`: one `UsageRow` per provider (Codex, Claude).
 * - `stages`: one `UsageRow` per workflow stage. Omit or pass `[]` to hide that table.
 * - `heading`: section heading, default "Measured usage".
 */
import { computed, useId } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { formatTokens, formatUsd, unknownText } from './format';
import type { UsageMetric, UsageRow } from './types';

defineOptions({ name: 'UsageSummary' });

const props = withDefaults(
  defineProps<{ providers: readonly UsageRow[]; stages?: readonly UsageRow[]; heading?: string }>(),
  { stages: () => [], heading: 'Measured usage' },
);

const headingId = useId();

const columns: readonly { metric: UsageMetric; label: string }[] = [
  { metric: 'inputTokens', label: 'Input tokens' },
  { metric: 'outputTokens', label: 'Output tokens' },
  { metric: 'cachedInputTokens', label: 'Cached input' },
  { metric: 'estimatedCostUsd', label: 'Estimated cost' },
];

const tables = computed(() =>
  [
    { caption: 'By provider', first: 'Provider', rows: props.providers },
    { caption: 'By stage', first: 'Stage', rows: props.stages },
  ].filter(table => table.rows.length > 0),
);

function display(row: UsageRow, metric: UsageMetric): string {
  return metric === 'estimatedCostUsd' ? formatUsd(row.estimatedCostUsd) : formatTokens(row[metric]);
}

function isUnknown(row: UsageRow, metric: UsageMetric): boolean {
  return row[metric] === null;
}

function isPartial(row: UsageRow, metric: UsageMetric): boolean {
  return row[metric] !== null && row.partial.includes(metric);
}
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-3 rounded-lg border border-default bg-default p-4">
    <h2 :id="headingId" class="text-base font-semibold text-highlighted">{{ heading }}</h2>
    <div v-for="table in tables" :key="table.caption" class="overflow-x-auto">
      <table class="w-full text-sm">
        <caption class="pb-1 text-left text-xs font-medium tracking-wide text-muted uppercase">
          {{
            table.caption
          }}
        </caption>
        <thead>
          <tr class="border-b border-default text-left text-xs text-muted">
            <th scope="col" class="py-1 pr-3 font-medium">{{ table.first }}</th>
            <th v-for="column in columns" :key="column.metric" scope="col" class="py-1 pr-3 text-right font-medium">
              {{ column.label }}
            </th>
            <th scope="col" class="py-1 text-right font-medium">Sessions measured</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in table.rows" :key="row.id" class="border-b border-muted last:border-0">
            <th scope="row" class="py-2 pr-3 text-left font-medium text-highlighted">{{ row.label }}</th>
            <td
              v-for="column in columns"
              :key="column.metric"
              class="py-2 pr-3 text-right tabular-nums"
              :data-metric="column.metric"
            >
              <span :class="isUnknown(row, column.metric) ? 'text-muted italic' : 'text-default'">
                {{ display(row, column.metric) }}
              </span>
              <template v-if="isPartial(row, column.metric)">
                <UBadge label="partial" color="warning" variant="outline" size="sm" class="ml-1" />
                <span class="sr-only">, a lower bound</span>
              </template>
            </td>
            <td class="py-2 text-right text-muted tabular-nums">
              <template v-if="row.sessions">{{ row.sessions.observed }} of {{ row.sessions.total }}</template>
              <span v-else class="italic">{{ unknownText }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!tables.length" class="text-sm text-muted">No usage observations yet.</p>
    <p class="text-xs text-muted">
      Provider token counts have different meanings. Estimated cost uses provider rates; billed cost is unknown.
    </p>
  </section>
</template>
