<!-- Review findings: blocking ones first, each with where it is and the scenario that fails. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { Finding } from '../../../src/domain/review';

const props = defineProps<{ findings: Finding[]; downgraded?: Finding[] }>();

const rows = computed(() => [
  ...props.findings
    .filter(finding => finding.severity === 'blocking')
    .map(finding => ({ finding, kind: 'blocking' as const })),
  ...(props.downgraded ?? []).map(finding => ({ finding, kind: 'downgraded' as const })),
  ...props.findings.filter(finding => finding.severity === 'note').map(finding => ({ finding, kind: 'note' as const })),
]);

const look = {
  blocking: { icon: 'i-lucide-octagon-alert', color: 'error', label: 'Blocking' },
  downgraded: {
    icon: 'i-lucide-circle-help',
    color: 'warning',
    label: 'Kept as a note: blocking without a location and scenario',
  },
  note: { icon: 'i-lucide-sticky-note', color: 'neutral', label: 'Note' },
} as const;
</script>

<template>
  <p v-if="!rows.length" class="text-sm text-muted">No findings.</p>
  <ul v-else class="space-y-2">
    <li v-for="({ finding, kind }, index) in rows" :key="index" class="rounded-lg border border-default p-3 space-y-1">
      <div class="flex items-start gap-2">
        <UTooltip :text="look[kind].label">
          <UIcon
            :name="look[kind].icon"
            class="size-4 mt-0.5 shrink-0"
            :class="{
              'text-error': kind === 'blocking',
              'text-warning': kind === 'downgraded',
              'text-muted': kind === 'note',
            }"
          />
        </UTooltip>
        <p class="font-medium text-sm">{{ finding.title }}</p>
      </div>
      <details :open="kind === 'blocking'" class="pl-6 text-sm">
        <summary class="cursor-pointer text-xs text-muted">{{ look[kind].label }} · evidence</summary>
        <p v-if="finding.file" class="font-mono text-xs text-muted break-all mt-2">
          {{ finding.file }}{{ finding.line ? `:${finding.line}` : '' }}
        </p>
        <p v-if="finding.criterion" class="text-sm text-muted pl-6 italic">"{{ finding.criterion }}"</p>
        <p v-if="finding.scenario" class="text-sm pl-6">
          <span class="text-muted">Fails when:</span> {{ finding.scenario }}
        </p>
        <p v-if="finding.detail" class="text-sm text-muted pl-6 whitespace-pre-line">{{ finding.detail }}</p>
      </details>
    </li>
  </ul>
</template>
