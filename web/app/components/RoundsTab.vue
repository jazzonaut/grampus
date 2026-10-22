<!--
  Verification evidence: the baseline before the change, then each round's integrity guard, checks,
  review and decision. Newest round first.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { TaskDetail } from '../../../src/dashboard/types';
import { shortSha } from '../presentation';
import CheckRun from './CheckRun.vue';
import FindingList from './FindingList.vue';

const props = defineProps<{ task: TaskDetail }>();

const rounds = computed(() => [...props.task.rounds].reverse());
const decisionLook = {
  ready: { color: 'success', icon: 'i-lucide-circle-check', label: 'Passed' },
  repair: { color: 'warning', icon: 'i-lucide-wrench', label: 'Sent to repair' },
  escalate: { color: 'error', icon: 'i-lucide-hand', label: 'Escalated' },
} as const;
const verdictColor = { approve: 'success', changes: 'warning', unknown: 'neutral' } as const;
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
        <ul v-if="round.decision?.reasons.length" class="mt-2 text-sm text-muted list-disc pl-5">
          <li v-for="reason in round.decision.reasons" :key="reason">{{ reason }}</li>
        </ul>
      </template>

      <div class="space-y-5">
        <section v-if="round.guard" class="space-y-2">
          <h4 class="text-sm font-medium flex flex-wrap items-center gap-2">
            <UIcon name="i-lucide-shield-check" class="size-4" /> Integrity guard
            <span class="font-mono text-xs text-dimmed"
              >{{ shortSha(round.guard.fromSha) }} → {{ shortSha(round.guard.sha) }}</span
            >
          </h4>
          <UAlert
            v-for="violation in round.guard.result.violations"
            :key="violation"
            color="error"
            variant="subtle"
            icon="i-lucide-shield-alert"
            :title="violation"
          />
          <p class="text-sm text-muted">
            {{ round.guard.result.commits }} commit{{ round.guard.result.commits === 1 ? '' : 's' }},
            {{ round.guard.result.changedFiles.length }} file{{
              round.guard.result.changedFiles.length === 1 ? '' : 's'
            }}
            changed{{ round.guard.result.clean ? ', clean tree' : ', uncommitted changes' }}
          </p>
          <UCollapsible v-if="round.guard.result.changedFiles.length">
            <UButton
              size="xs"
              color="neutral"
              variant="link"
              trailing-icon="i-lucide-chevron-down"
              label="Changed files"
            />
            <template #content>
              <ul class="font-mono text-xs text-muted space-y-0.5 pt-1">
                <li v-for="file in round.guard.result.changedFiles" :key="file">{{ file }}</li>
              </ul>
            </template>
          </UCollapsible>
          <p v-if="round.guard.result.modifiedTests.length" class="text-sm text-warning">
            Existing tests modified:
            <span class="font-mono text-xs">{{ round.guard.result.modifiedTests.join(', ') }}</span>
          </p>
        </section>

        <CheckRun v-if="round.checks" :task-id="task.taskId" :run="round.checks" title="Checks" />

        <section v-if="round.review" class="space-y-2">
          <h4 class="text-sm font-medium flex items-center gap-2">
            <UIcon name="i-lucide-scan-eye" class="size-4" /> Review
            <UBadge
              v-if="round.review.report"
              :color="verdictColor[round.review.report.verdict]"
              variant="subtle"
              size="sm"
            >
              {{ round.review.report.verdict }}
            </UBadge>
          </h4>
          <UAlert
            v-if="!round.review.report"
            color="warning"
            variant="subtle"
            :title="`Review unavailable: ${round.review.error ?? 'unknown'}`"
          />
          <template v-else>
            <p class="text-sm">{{ round.review.report.summary }}</p>
            <FindingList :findings="round.review.report.findings" :downgraded="round.review.downgraded" />
          </template>
        </section>
        <p v-else-if="!task.recipeSnapshot.review" class="text-sm text-muted">This recipe has no code review.</p>

        <p v-if="!round.guard && !round.checks" class="text-sm text-muted flex items-center gap-2">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" /> The worker is still editing.
        </p>
      </div>
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
