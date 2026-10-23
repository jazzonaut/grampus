<!--
  Verification evidence: the baseline before the change, then each round's integrity guard, checks,
  review and decision. Newest round first.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { TaskDetail } from '../../../src/dashboard/types';
import { shortSha } from '../presentation';
import CheckRun from './CheckRun.vue';
import RoundEvidence from './RoundEvidence.vue';

const props = defineProps<{ task: TaskDetail }>();

const rounds = computed(() => [...props.task.rounds].reverse());
const latest = computed(() => rounds.value[0]);
const decisionLook = {
  ready: { color: 'success', icon: 'i-lucide-circle-check', label: 'Passed' },
  repair: { color: 'warning', icon: 'i-lucide-wrench', label: 'Sent to repair' },
  escalate: { color: 'error', icon: 'i-lucide-hand', label: 'Escalated' },
} as const;
</script>

<template>
  <div class="space-y-6">
    <UEmpty
      v-if="!task.rounds.length && !task.baseline"
      icon="i-lucide-hammer"
      title="Nothing built yet"
      description="Rounds appear here once the spec is approved and the build starts."
    />

    <div v-if="latest" class="flex flex-wrap gap-2 text-sm" aria-label="Latest verification status">
      <span class="rounded-lg border border-default px-3 py-2"
        >Checks:
        {{
          !latest.checks?.results.length
            ? 'not recorded'
            : `${latest.checks.results.filter(result => result.passed).length}/${latest.checks.results.length} passed`
        }}</span
      >
      <span class="rounded-lg border border-default px-3 py-2"
        >Review: {{ latest.review?.report?.verdict ?? 'unavailable' }}</span
      >
      <span
        v-if="latest.checks?.results.some(result => !result.passed)"
        class="rounded-lg border border-warning/40 px-3 py-2 text-warning"
        >Verification incomplete</span
      >
    </div>
    <details
      v-for="(round, index) in rounds"
      :key="round.round"
      :open="index === 0"
      class="rounded-xl border border-default p-4"
    >
      <summary class="cursor-pointer text-sm font-semibold">
        {{ round.round === 0 ? 'Build' : `Repair round ${round.round}` }}
        <span class="font-normal text-muted"
          >· {{ round.decision ? decisionLook[round.decision.decision].label : 'In progress'
          }}{{ index === 0 ? ' · latest' : '' }}</span
        >
      </summary>
      <div class="mt-4 space-y-4">
        <ul
          v-if="round.decision && (round.decision.reasons.length || round.decision.builderFailure)"
          class="mt-2 text-sm text-muted list-disc pl-5"
        >
          <li v-if="round.decision.builderFailure">The builder reported failure; its report is below</li>
          <li v-for="reason in round.decision.reasons" :key="reason">{{ reason }}</li>
        </ul>

        <RoundEvidence :task="task" :round="round" />
      </div>
    </details>

    <details v-if="task.testsFirst" class="rounded-lg border border-default p-4">
      <summary class="cursor-pointer text-sm font-medium">
        Acceptance tests · {{ task.testsFirst.files.length }} protected files
      </summary>
      <UCard class="mt-3">
        <template #header>
          <h3 class="font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-flask-conical" class="size-4" /> Acceptance tests
          </h3>
        </template>
        <p class="text-sm text-muted">
          Committed at <span class="font-mono">{{ shortSha(task.testsFirst.sha) }}</span
          >; these files are protected:
        </p>
        <ul class="font-mono text-xs text-muted mt-1">
          <li v-for="file in task.testsFirst.files" :key="file">{{ file }}</li>
        </ul>
      </UCard>
    </details>

    <details v-if="task.baseline" class="rounded-lg border border-default p-4">
      <summary class="cursor-pointer text-sm font-medium">
        Baseline · {{ task.baseline.results.filter(result => !result.passed).length }} failed before the change
      </summary>
      <UCard class="mt-3">
        <template #header>
          <h3 class="font-semibold flex items-center gap-2"><UIcon name="i-lucide-ruler" class="size-4" /> Baseline</h3>
          <p class="text-sm text-muted">The checks before any change, so failures that already existed are known.</p>
        </template>
        <CheckRun :task-id="task.taskId" :run="task.baseline" title="Before the change" />
      </UCard>
    </details>
  </div>
</template>
