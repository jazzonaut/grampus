<script setup lang="ts">
/**
 * WorkflowStrip: a task's stages in order, each with its state as icon and text.
 *
 * Stages are data, not a fixed list: quality passes are configurable, so the server decides
 * which stages a task has and in what order.
 *
 * Props:
 * - `stages`: the ordered stages (`WorkflowStage`, the server's `StageView`: id, label, state,
 *   detail, and optionally who established the result and lens sub-items).
 * - `label`: accessible name of the list, default "Workflow".
 *
 * The active stage is marked `aria-current="step"`. States are passed, pending, active,
 * failed, unknown and skipped; unknown is never drawn as passed. A passed result names who
 * established it, so an agent's claim never reads like a verified check.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import { stagePresentation } from '../theme/status';
import type { EvidenceSource, StageState, WorkflowStage } from './types';

defineOptions({ name: 'WorkflowStrip' });

withDefaults(defineProps<{ stages: readonly WorkflowStage[]; label?: string }>(), { label: 'Workflow' });

const evidenceLabels: Readonly<Record<EvidenceSource, string>> = {
  'controller-verified': 'verified by Grampus',
  'agent-reported': 'agent reported',
  'human-assessed': 'your assessment',
};

// Literal class names so Tailwind finds them.
const tone: Readonly<Record<StageState, string>> = {
  passed: 'border-success/40 text-success',
  pending: 'border-default text-muted',
  active: 'border-info text-info ring-1 ring-info/40',
  failed: 'border-error/60 text-error',
  unknown: 'border-dashed border-accented text-muted',
  skipped: 'border-dashed border-default text-dimmed',
};
</script>

<template>
  <ol :aria-label="label" class="flex flex-wrap gap-2">
    <li
      v-for="(stage, index) in stages"
      :key="stage.id"
      :aria-current="stage.state === 'active' ? 'step' : undefined"
      :data-state="stage.state"
      :class="['flex min-w-0 items-center gap-2 rounded-md border bg-default px-3 py-2 text-sm', tone[stage.state]]"
    >
      <UIcon
        :name="stagePresentation[stage.state].icon"
        :class="['size-4 shrink-0', stage.state === 'active' ? 'motion-safe:animate-spin' : '']"
        aria-hidden="true"
      />
      <span class="min-w-0">
        <span class="sr-only">Step {{ index + 1 }}: </span>
        <span class="font-medium text-highlighted">{{ stage.label }}</span>
        <span class="block text-xs">
          {{ stagePresentation[stage.state].label
          }}<template v-if="stage.evidence"> · {{ evidenceLabels[stage.evidence] }}</template
          ><template v-if="stage.detail"> · {{ stage.detail }}</template>
        </span>
      </span>
    </li>
  </ol>
</template>
