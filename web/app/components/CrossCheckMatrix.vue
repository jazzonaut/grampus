<!--
  The cross-check of a full comparison: rows are the specs whose checks ran, columns the results they ran
  against. The diagonal is each entry's own verification; the rest show whether a result also meets the
  other recipes' specs. A check whose copied tests did not compile against a result is counted apart as
  incompatible: the two recipes chose different APIs, which says nothing about behaviour.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { CrossCheckCell } from '../../../src/compare/comparison';
import type { ComparisonEntryView } from '../../../src/dashboard/types';

const props = defineProps<{ cells: CrossCheckCell[]; entries: ComparisonEntryView[] }>();

const recipeOf = computed(() => new Map(props.entries.map(entry => [entry.task.taskId, entry.recipe])));
const ids = computed(() => props.entries.map(entry => entry.task.taskId));

function cellOf(specOf: string, candidate: string): CrossCheckCell | undefined {
  return props.cells.find(cell => cell.specOf === specOf && cell.candidate === candidate);
}

function summary(cell: CrossCheckCell | undefined): { text: string; tone: string; title: string } {
  if (!cell) return { text: '-', tone: 'text-dimmed', title: 'Not measured' };
  if (!cell.results) return { text: '?', tone: 'text-warning', title: cell.error ?? 'Unknown' };
  const passed = cell.results.filter(result => result.passed).length;
  const incompatible = new Set(cell.incompatible ?? []);
  const failed = cell.results
    .filter(result => !result.passed && !incompatible.has(result.name))
    .map(result => result.name);
  const titles = [
    ...(failed.length ? [`Failed: ${failed.join(', ')}`] : []),
    ...(incompatible.size ? [`Incompatible API (copied tests did not compile): ${[...incompatible].join(', ')}`] : []),
  ];
  return {
    text: `${passed}/${cell.results.length}${incompatible.size ? ` · ${incompatible.size} API` : ''}`,
    tone:
      passed === cell.results.length
        ? 'bg-success/15 text-success'
        : failed.length
          ? 'bg-error/15 text-error'
          : 'bg-warning/15 text-warning',
    title: titles.length ? titles.join('. ') : 'Every check passed',
  };
}
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-default">
    <table class="text-sm">
      <thead class="bg-elevated/50 text-xs text-muted">
        <tr>
          <th class="px-3 py-2 text-left font-medium">Spec of ↓ / result of →</th>
          <th v-for="candidate in ids" :key="candidate" class="px-3 py-2 text-center font-medium">
            {{ recipeOf.get(candidate) }}
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-default">
        <tr v-for="specOf in ids" :key="specOf">
          <th class="px-3 py-2 text-left font-medium">{{ recipeOf.get(specOf) }}</th>
          <td v-for="candidate in ids" :key="candidate" class="px-2 py-1.5 text-center">
            <UTooltip :text="summary(cellOf(specOf, candidate)).title">
              <span
                class="inline-block min-w-14 rounded-md px-2 py-1 tabular-nums font-medium"
                :class="[
                  summary(cellOf(specOf, candidate)).tone,
                  specOf === candidate ? 'ring-1 ring-(--ui-border-accented)' : '',
                ]"
              >
                {{ summary(cellOf(specOf, candidate)).text }}
              </span>
            </UTooltip>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
