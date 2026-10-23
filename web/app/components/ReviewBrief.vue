<!-- Review conclusions stay visible; supporting evidence is opened per outcome. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { Finding, ReviewReport } from '../../../src/domain/review';
import ChangeNote from './ChangeNote.vue';
import FindingList from './FindingList.vue';

const props = defineProps<{ report: ReviewReport; downgraded?: Finding[] }>();
const coverage = computed(() =>
  [...(props.report.coverage ?? [])].sort((a, b) => Number(a.status === 'verified') - Number(b.status === 'verified')),
);
// Repeated caveats share one entry, but retain every affected outcome id.
const caveats = computed(() => {
  const items = new Map<string, string[]>();
  for (const row of coverage.value)
    for (const text of row.limitations) {
      const ids = items.get(text) ?? [];
      if (!ids.includes(row.acceptanceId)) ids.push(row.acceptanceId);
      items.set(text, ids);
    }
  return [...items].map(([text, ids]) => ({ text, ids }));
});
</script>

<template>
  <div class="space-y-3 min-w-0">
    <ChangeNote :source="report.summary" />
    <details
      v-for="probe in report.probes ?? []"
      :key="probe.scenario"
      class="rounded-lg border border-default p-3"
      :open="!probe.regressionTest"
    >
      <summary class="cursor-pointer text-sm font-medium">
        {{ probe.scenario }}: {{ probe.regressionTest ? 'regression retained' : 'regression needed' }}
      </summary>
      <p v-if="probe.regressionTest" class="mt-2 text-sm">
        {{ probe.regressionTest.file }}: {{ probe.regressionTest.test }}
      </p>
      <p class="mt-2 text-sm">{{ probe.command }}</p>
      <pre class="mt-2 whitespace-pre-wrap break-words text-xs">{{ probe.source }}</pre>
    </details>
    <FindingList
      v-if="report.findings.length || downgraded?.length"
      :findings="report.findings"
      :downgraded="downgraded"
    />
    <details
      v-if="report.requestCoverage"
      class="rounded-lg border border-default p-3"
      :open="report.requestCoverage.verdict !== 'covered'"
    >
      <summary class="cursor-pointer text-sm font-medium">
        Original request:
        <span :class="report.requestCoverage.verdict !== 'covered' ? 'text-warning' : 'text-muted'">{{
          report.requestCoverage.verdict
        }}</span>
      </summary>
      <p class="mt-2 text-sm whitespace-pre-line break-words">{{ report.requestCoverage.rationale }}</p>
    </details>
    <section v-if="coverage.length" class="space-y-2">
      <h4 class="text-sm font-medium">
        Outcomes
        <span class="text-muted font-normal"
          >{{ coverage.filter(item => item.status === 'verified').length }}/{{ coverage.length }} verified</span
        >
      </h4>
      <details
        v-for="item in coverage"
        :key="item.acceptanceId"
        class="rounded-lg border border-default p-3"
        :open="item.status !== 'verified'"
      >
        <summary class="cursor-pointer text-sm">
          <span class="font-medium break-words">{{ item.acceptanceId.replaceAll('-', ' ') }}</span>
          <span class="ml-2" :class="item.status === 'verified' ? 'text-muted' : 'text-warning'">{{
            item.status
          }}</span>
          <span v-if="item.limitations.length" class="ml-2 text-xs text-warning"
            >{{ item.limitations.length }} caveat{{ item.limitations.length === 1 ? '' : 's' }}</span
          >
        </summary>
        <p class="mt-2 text-sm whitespace-pre-line break-words">{{ item.evidence }}</p>
      </details>
    </section>
    <details
      v-if="caveats.length"
      class="border-l-2 border-warning/50 pl-3"
      :open="report.verdict !== 'approve' || coverage.some(item => item.status !== 'verified')"
    >
      <summary class="cursor-pointer text-sm font-medium text-warning">
        {{ caveats.length }} evidence caveat{{ caveats.length === 1 ? '' : 's' }}
      </summary>
      <ul class="mt-2 space-y-3 text-sm">
        <li v-for="item in caveats" :key="item.text">
          <p class="text-xs text-muted mb-1">{{ item.ids.join(', ') }}</p>
          <p class="whitespace-pre-line break-words">{{ item.text }}</p>
        </li>
      </ul>
    </details>
  </div>
</template>
