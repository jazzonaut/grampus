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

    <UCard v-for="round in rounds" :key="round.round">
      <template #header>
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-semibold flex items-center gap-2">
            <UIcon :name="round.round === 0 ? 'i-lucide-hammer' : 'i-lucide-wrench'" class="size-4" />
            {{ round.round === 0 ? 'Build' : `Repair round ${round.round}` }}
          </h3>
          <UBadge
            v-if="round.decision"
            :color="decisionLook[round.decision.decision].color"
            :icon="decisionLook[round.decision.decision].icon"
            variant="subtle"
          >
            {{ decisionLook[round.decision.decision].label }}
          </UBadge>
        </div>
        <ul
          v-if="round.decision && (round.decision.reasons.length || round.decision.builderFailure)"
          class="mt-2 text-sm text-muted list-disc pl-5"
        >
          <li v-if="round.decision.builderFailure">The builder reported failure; its report is below</li>
          <li v-for="reason in round.decision.reasons" :key="reason">{{ reason }}</li>
        </ul>
      </template>

      <RoundEvidence :task="task" :round="round" />
    </UCard>

    <UCard v-if="task.testsFirst">
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

    <UCard v-if="task.baseline">
      <template #header>
        <h3 class="font-semibold flex items-center gap-2"><UIcon name="i-lucide-ruler" class="size-4" /> Baseline</h3>
        <p class="text-sm text-muted">The checks before any change, so failures that already existed are known.</p>
      </template>
      <CheckRun :task-id="task.taskId" :run="task.baseline" title="Before the change" />
    </UCard>
  </div>
</template>
