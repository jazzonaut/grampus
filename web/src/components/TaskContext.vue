<script setup lang="ts">
/** Owns compact task context beside the active work, with links to full results and resource details. */
import type { TaskDetailV1 } from '../../../src/server/api-types';
import { evidenceLabels, stagePresentation } from '../theme/status';

defineProps<{ task: TaskDetailV1 }>();
defineEmits<{ select: [view: string] }>();
</script>

<template>
  <section class="grampus-surface" data-panel="verification-summary">
    <h2 class="text-base font-semibold text-highlighted">Verification</h2>
    <ul class="mt-3 flex flex-col gap-3 text-sm">
      <li
        v-for="stage in task.workflow.filter(item => ['validate', 'accept', 'review', 'deliver'].includes(item.id))"
        :key="stage.id"
      >
        <div class="flex justify-between gap-3">
          <span>{{ stage.label }}</span
          ><span class="text-muted">{{ stagePresentation[stage.state].label }}</span>
        </div>
        <p v-if="stage.evidence" class="mt-0.5 text-xs text-muted">{{ evidenceLabels[stage.evidence] }}</p>
      </li>
    </ul>
    <button type="button" class="mt-4 text-sm text-primary hover:underline" @click="$emit('select', 'results')">
      View criteria and checks →
    </button>
  </section>
  <section class="grampus-surface" data-panel="run-summary">
    <h2 class="text-base font-semibold text-highlighted">Run summary</h2>
    <dl class="mt-3 flex flex-col gap-2 text-sm">
      <div class="flex justify-between gap-3">
        <dt class="text-muted">Implementer</dt>
        <dd>{{ task.details.plan.implementer.label }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-muted">Reviewer</dt>
        <dd>{{ task.details.plan.reviewer.label }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-muted">Slice</dt>
        <dd>{{ task.header.slice.index }} of {{ task.header.slice.count }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-muted">Behavioural repairs</dt>
        <dd>{{ task.repairs.used }} of {{ task.repairs.allowance }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-muted">Readiness repairs</dt>
        <dd>{{ task.repairs.readiness.used }} of {{ task.repairs.readiness.allowance }}</dd>
      </div>
    </dl>
    <p class="mt-3 text-sm font-medium" :data-status="task.spending.status">{{ task.spending.statusLabel }}</p>
    <p class="mt-1 text-xs text-muted">{{ task.spending.turnsLabel }}</p>
    <button type="button" class="mt-4 text-sm text-primary hover:underline" @click="$emit('select', 'usage')">
      Usage and limits →
    </button>
  </section>
</template>
