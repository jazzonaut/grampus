<!--
  One round's evidence: the builder's report when it said it failed, the integrity guard, the checks and the
  review. Shared by the rounds tab and the decision panel, so a decision shows the same evidence as its round.
-->
<script setup lang="ts">
import type { RoundView, TaskDetail } from '../../../src/dashboard/types';
import { shortSha } from '../presentation';
import CheckRun from './CheckRun.vue';
import FindingList from './FindingList.vue';
import MarkdownView from './MarkdownView.vue';

defineProps<{ task: TaskDetail; round: RoundView }>();

const verdictColor = { approve: 'success', changes: 'warning', unknown: 'neutral' } as const;
</script>

<template>
  <div class="space-y-5">
    <section v-if="round.decision?.builderFailure" class="space-y-2">
      <h4 class="text-sm font-medium flex items-center gap-2">
        <UIcon name="i-lucide-bot-message-square" class="size-4" /> The builder's report
        <UBadge color="error" variant="subtle" size="sm">reported failure</UBadge>
      </h4>
      <div class="rounded-lg border border-default bg-default px-3 py-2">
        <MarkdownView :source="round.decision.builderFailure" />
      </div>
    </section>

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
        <UButton size="xs" color="neutral" variant="link" trailing-icon="i-lucide-chevron-down" label="Changed files" />
        <template #content>
          <ul class="font-mono text-xs text-muted space-y-0.5 pt-1">
            <li v-for="file in round.guard.result.changedFiles" :key="file">{{ file }}</li>
          </ul>
        </template>
      </UCollapsible>
      <div v-if="round.guard.result.modifiedTests.length" class="text-sm text-warning space-y-0.5">
        <p>
          {{ round.guard.result.modifiedTests.length }} existing test file{{
            round.guard.result.modifiedTests.length === 1 ? '' : 's'
          }}
          modified:
        </p>
        <ul class="font-mono text-xs space-y-0.5">
          <li v-for="file in round.guard.result.modifiedTests" :key="file">{{ file }}</li>
        </ul>
      </div>
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
</template>
