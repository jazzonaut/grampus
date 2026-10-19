<script setup lang="ts">
/**
 * PlanSlice: one slice of a plan as approval shows it: approach, criteria, the files it may edit, create
 * and delete, its preparation, validation and acceptance commands, the exact expected output and how it
 * is delivered. Commands, paths and expected output stay literal.
 *
 * Props:
 * - `slice`: the server's `PlanSliceView`.
 * - `index`: 0-based position, shown as "Slice 1".
 */
import type { PlanSliceView } from '../../../src/server/api-types';
import MarkdownView from './MarkdownView.vue';
import { formatTimeout } from './format';

defineOptions({ name: 'PlanSlice' });

defineProps<{ slice: PlanSliceView; index: number }>();
</script>

<template>
  <details class="group py-3" :data-slice="index + 1">
    <summary class="flex cursor-pointer list-none items-center gap-3 font-medium text-highlighted">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{{
        index + 1
      }}</span>
      <span class="min-w-0 flex-1"
        >{{ slice.title
        }}<span class="mt-1 block text-xs font-normal text-muted"
          >{{ slice.files.edit.length }} edit · {{ slice.files.create.length }} create ·
          {{ slice.files.delete.length }} delete</span
        ></span
      >
      <span class="text-muted group-open:rotate-90" aria-hidden="true">›</span>
    </summary>
    <div class="mt-4 flex flex-col gap-3 border-l-2 border-primary/20 pl-4">
      <MarkdownView v-if="slice.approach" :source="slice.approach" class="text-sm" />
      <ul v-if="slice.criteria.length" class="list-disc pl-5 text-sm">
        <li v-for="criterion in slice.criteria" :key="criterion"><MarkdownView :source="criterion" inline /></li>
      </ul>
      <div class="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <p class="text-xs text-muted">Files to edit</p>
          <pre class="grampus-code">{{ slice.files.edit.join('\n') || '(none)' }}</pre>
        </div>
        <div v-if="slice.files.create.length">
          <p class="text-xs text-muted">Files to create</p>
          <pre class="grampus-code">{{ slice.files.create.join('\n') }}</pre>
        </div>
        <div v-if="slice.files.delete.length">
          <p class="text-xs text-muted">Files to delete</p>
          <pre class="grampus-code">{{ slice.files.delete.join('\n') }}</pre>
        </div>
      </div>
      <div v-if="slice.preparation" class="flex flex-col gap-1">
        <p class="text-xs text-muted">
          Preparation after implementation · {{ slice.preparation.name }} ·
          {{ formatTimeout(slice.preparation.timeoutMs) }}. May update only this slice's authorized files before
          validation.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <p class="text-xs text-muted">
          Validation · {{ slice.validation.name }} · {{ formatTimeout(slice.validation.timeoutMs) }}
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <p class="text-xs text-muted">
          Acceptance · {{ slice.acceptance.name }} · {{ formatTimeout(slice.acceptance.timeoutMs) }}
        </p>
      </div>
      <p class="text-xs text-muted">
        Delivery: {{ slice.delivery.mode === 'commit' ? 'local commit' : 'no change expected' }} ·
        {{ slice.delivery.message }}
      </p>
    </div>
  </details>
</template>
