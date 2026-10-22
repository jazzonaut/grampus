<!-- The task's pipeline as a strip of steps, scrolling sideways on narrow screens. -->
<script setup lang="ts">
import type { PipelineStep } from '../../../src/dashboard/types';
import { stepIcon, stepStateLook } from '../presentation';
import StatusIcon from './StatusIcon.vue';

defineProps<{ steps: PipelineStep[] }>();

const ring: Record<PipelineStep['state'], string> = {
  pending: 'border-default text-muted',
  running: 'border-primary/60 bg-primary/10 text-highlighted',
  waiting: 'border-warning/60 bg-warning/10 text-highlighted',
  done: 'border-success/40 text-default',
  failed: 'border-error/60 bg-error/10 text-highlighted',
  skipped: 'border-dashed border-default text-dimmed',
};
</script>

<template>
  <ol class="flex items-center gap-1 overflow-x-auto py-1 -mx-1 px-1" aria-label="Pipeline">
    <template v-for="(step, index) in steps" :key="step.id">
      <li v-if="index" class="h-px w-3 shrink-0 bg-(--ui-border-accented)" aria-hidden="true" />
      <li class="shrink-0">
        <UTooltip :text="`${step.label}: ${stepStateLook[step.state].label}${step.detail ? ` (${step.detail})` : ''}`">
          <div class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs" :class="ring[step.state]">
            <UIcon :name="stepIcon[step.id]" class="size-3.5" />
            <span class="font-medium" :class="{ 'line-through': step.state === 'skipped' }">{{ step.label }}</span>
            <StatusIcon v-if="step.state !== 'skipped'" :look="stepStateLook[step.state]" size="size-3.5" />
          </div>
        </UTooltip>
      </li>
    </template>
  </ol>
</template>
