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
 * failed, unknown and skipped; unknown is never drawn as passed. A result names who established
 * it, so an agent's claim never reads like a verified check. The review's lens assessments are
 * listed under it.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import { evidenceLabels, stagePresentation } from '../theme/status';
import type { StageState, WorkflowStage } from './types';

defineOptions({ name: 'WorkflowStrip' });

withDefaults(defineProps<{ stages: readonly WorkflowStage[]; label?: string }>(), { label: 'Workflow' });

// Literal class names so Tailwind finds them.
const tone: Readonly<Record<StageState, string>> = {
  passed: 'border-success/40 text-success',
  pending: 'border-default text-muted',
  active: 'border-primary text-primary ring-1 ring-primary/40',
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
      :data-stage="stage.id"
      :class="['flex min-w-0 items-start gap-2 rounded-md border bg-default px-3 py-2 text-sm', tone[stage.state]]"
    >
      <UIcon
        :name="stagePresentation[stage.state].icon"
        :class="['mt-0.5 size-4 shrink-0', stage.state === 'active' ? 'motion-safe:animate-spin' : '']"
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
        <ul v-if="stage.items?.length" class="mt-1 flex flex-col gap-0.5 text-xs" :aria-label="`${stage.label} lenses`">
          <li v-for="item in stage.items" :key="item.id" class="flex items-center gap-1" :data-state="item.state">
            <UIcon :name="stagePresentation[item.state].icon" class="size-3 shrink-0" aria-hidden="true" />
            <span class="text-default">{{ item.label }}:</span>
            {{ stagePresentation[item.state].label
            }}<template v-if="item.evidence"> · {{ evidenceLabels[item.evidence] }}</template
            ><template v-if="item.detail"> · {{ item.detail }}</template>
          </li>
        </ul>
      </span>
    </li>
  </ol>
</template>
