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
          >Provisional approach · agent chooses files and commands</span
        ></span
      >
      <span class="text-muted group-open:rotate-90" aria-hidden="true">›</span>
    </summary>
    <div class="mt-4 flex flex-col gap-3 border-l-2 border-primary/20 pl-4">
      <div v-if="slice.directories.length">
        <p class="text-xs text-muted">Suggested folders, not execution permissions</p>
        <pre class="grampus-code">{{ JSON.stringify(slice.directories, null, 2) }}</pre>
      </div>
      <MarkdownView v-if="slice.approach" :source="slice.approach" class="text-sm" />
      <ul v-if="slice.criteria.length" class="list-disc pl-5 text-sm">
        <li v-for="criterion in slice.criteria" :key="criterion"><MarkdownView :source="criterion" inline /></li>
      </ul>
      <div class="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <p class="text-xs text-muted">Suggested files to edit</p>
          <pre class="grampus-code">{{ slice.files.edit.join('\n') || '(none)' }}</pre>
        </div>
        <div v-if="slice.files.create.length">
          <p class="text-xs text-muted">Suggested files to create</p>
          <pre class="grampus-code">{{ slice.files.create.join('\n') }}</pre>
        </div>
        <div v-if="slice.files.delete.length">
          <p class="text-xs text-muted">Suggested files to delete</p>
          <pre class="grampus-code">{{ slice.files.delete.join('\n') }}</pre>
        </div>
      </div>
      <p v-if="slice.formatting" class="text-xs text-muted">
        Suggested formatting · {{ slice.formatting.name }} · {{ formatTimeout(slice.formatting.timeoutMs) }}
      </p>
      <div v-if="slice.preparation" class="flex flex-col gap-1">
        <p class="text-xs text-muted">
          Suggested setup · {{ slice.preparation.name }} · {{ formatTimeout(slice.preparation.timeoutMs) }}. The agent
          adapts and runs setup before submission.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <p v-for="check in slice.readiness" :key="check.kind" class="text-xs text-muted">
          Readiness ({{ check.kind }}) · {{ check.name }} · {{ formatTimeout(check.timeoutMs) }}
        </p>
        <p v-if="!slice.readiness.length" class="text-xs text-muted">No separate readiness checks configured.</p>
        <p v-if="slice.readinessConcurrency > 1" class="text-xs text-muted">
          Up to {{ slice.readinessConcurrency }} independent readiness checks may run together.
        </p>
        <p v-for="check in slice.reusableChecks" :key="check.name" class="text-xs text-muted">
          {{ check.name }} may reuse a successful diagnostic when all declared inputs match. Additional input trees:
          {{ check.inputs.join(', ') || '(none)' }}. This declares a local check with no uncontrolled external inputs.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <p class="text-xs text-muted">
          Validation · {{ slice.validation.name }} · {{ formatTimeout(slice.validation.timeoutMs) }}
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <p v-for="check in slice.acceptance" :key="check.name" class="text-xs text-muted">
          Acceptance · {{ check.name }} · {{ formatTimeout(check.timeoutMs) }}
        </p>
        <p v-if="slice.acceptance.length > 1" class="text-xs text-muted">
          Run in this order; the first failure stops the rest.
        </p>
      </div>
      <p class="text-xs text-muted">
        Delivery: {{ slice.delivery.mode === 'commit' ? 'local commit' : 'no change expected' }} ·
        {{ slice.delivery.message }}
      </p>
    </div>
  </details>
</template>
