<script setup lang="ts">
/** Owns the approved agents, workflow and quality policy presentation, without interpreting gates. */
import type { PlanView } from '../../../src/server/api-types';
import SectionHeading from './SectionHeading.vue';
import MarkdownView from './MarkdownView.vue';
defineProps<{ plan: PlanView }>();
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="grampus-surface">
      <SectionHeading title="Agents and workflow" icon="i-lucide-bot" />
      <dl class="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
        <dt class="text-muted">Implementer</dt>
        <dd>{{ plan.implementer.label }} · {{ plan.implementer.model ?? 'Provider default' }}</dd>
        <dt class="text-muted">Independent reviewer</dt>
        <dd>{{ plan.reviewer.label }} · {{ plan.reviewer.model ?? 'Provider default' }}</dd>
        <dt class="text-muted">Workspace</dt>
        <dd class="break-all">
          {{ plan.workspace.path ?? (plan.workspace.adapter === 'orca' ? 'Created through Orca' : 'Chosen at start') }}
        </dd>
      </dl>
      <p class="mt-4 text-sm text-toned">
        {{ plan.mode === 'automatic' ? 'Automatic' : 'Supervised' }} workflow · Sequential local delivery
      </p>
      <details class="mt-3 text-sm">
        <summary class="cursor-pointer text-muted">Workflow and repair policy</summary>
        <p class="mt-3 text-toned" data-summary="workflow">{{ plan.workflowSummary }}</p>
        <p class="mt-3 text-toned" data-summary="review">{{ plan.reviewSummary }}</p>
      </details>
      <p class="mt-3 text-xs text-muted">No automatic agent time limit. Delivery is local; nothing is pushed.</p>
    </section>
    <section class="grampus-surface">
      <SectionHeading title="Checks and quality" icon="i-lucide-shield-check" />
      <details class="text-sm">
        <summary class="cursor-pointer text-muted">How quality passes run</summary>
        <p class="mt-3 text-toned" data-summary="quality">{{ plan.qualitySummary }}</p>
      </details>
      <ul class="mt-4 divide-y divide-default">
        <li v-for="pass in plan.qualityPasses" :key="pass.id" class="py-3 text-sm">
          <p class="font-medium text-highlighted">
            {{ pass.title }}
            <span class="text-xs font-normal text-muted">{{ pass.kind === 'lens' ? 'Review lens' : 'Edit pass' }}</span>
          </p>
          <details class="mt-1">
            <summary class="cursor-pointer text-xs text-muted">Approved instructions</summary>
            <MarkdownView :source="pass.instructions" class="mt-2 text-toned" />
          </details>
        </li>
      </ul>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-3 text-sm">
        <dt class="text-muted">Validation</dt>
        <dd>{{ plan.slices.length }} named slice checks</dd>
        <dt class="text-muted">Acceptance</dt>
        <dd>Each slice, then all criteria and integration on the final slice</dd>
      </dl>
    </section>
  </div>
</template>
