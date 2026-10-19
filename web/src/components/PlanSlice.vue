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
import CommandDetails from './CommandDetails.vue';
import MarkdownView from './MarkdownView.vue';
import { formatTimeout } from './format';

defineOptions({ name: 'PlanSlice' });

defineProps<{ slice: PlanSliceView; index: number }>();
</script>

<template>
  <section class="flex flex-col gap-2 rounded-md border border-default p-3" :data-slice="index + 1">
    <h4 class="font-semibold text-highlighted">Slice {{ index + 1 }} · {{ slice.title }}</h4>
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
      <CommandDetails :command="slice.preparation" />
    </div>
    <div class="flex flex-col gap-1">
      <p class="text-xs text-muted">
        Validation · {{ slice.validation.name }} · {{ formatTimeout(slice.validation.timeoutMs) }}
      </p>
      <CommandDetails :command="slice.validation" />
    </div>
    <div class="flex flex-col gap-1">
      <p class="text-xs text-muted">
        Acceptance · {{ slice.acceptance.name }} · {{ formatTimeout(slice.acceptance.timeoutMs) }}
      </p>
      <CommandDetails :command="slice.acceptance" />
      <template v-if="slice.acceptance.expectedStdout !== null">
        <p class="text-xs text-muted">Exact expected stdout (JSON escaped)</p>
        <pre class="grampus-code" data-expected-stdout>{{ JSON.stringify(slice.acceptance.expectedStdout) }}</pre>
      </template>
      <template v-if="slice.acceptance.expectations">
        <p class="text-xs text-muted">Additional acceptance observations</p>
        <pre class="grampus-code">{{ slice.acceptance.expectations }}</pre>
      </template>
    </div>
    <p class="text-xs text-muted">
      Delivery: {{ slice.delivery.mode === 'commit' ? 'local commit' : 'no change expected' }} ·
      {{ slice.delivery.message }}
    </p>
  </section>
</template>
