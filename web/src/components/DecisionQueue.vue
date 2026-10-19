<script setup lang="ts">
/**
 * DecisionQueue: the decisions a task offers now, one DecisionCard per `ActionView`, with what to inspect
 * beside each one: the exact plan version and digest to approve, the files and contents to authorize.
 * The report action downloads the Markdown report. When nothing needs a decision it says so.
 *
 * Props:
 * - `decisions`: the actions to show (the page leaves out stop, revision and lifecycle management).
 * - `task`: the `TaskDetailV1` they belong to.
 * - `busy`, `sending`, `issuesFor`: from `useActions`.
 *
 * Emits `run` with the action and its drafts.
 */
import { ref } from 'vue';
import type { ActionView, TaskDetailV1 } from '../../../src/server/api-types';
import type { FieldIssue, FormDrafts } from '../api/actions';
import { ApiError } from '../api/client';
import { downloadReport } from '../api/report';
import DecisionCard from './DecisionCard.vue';
import ScopeReview from './ScopeReview.vue';
import { short } from './format';

defineOptions({ name: 'DecisionQueue' });

const props = defineProps<{
  decisions: readonly ActionView[];
  task: TaskDetailV1;
  busy: boolean;
  sending: string | null;
  issuesFor: (actionId: string) => FieldIssue[];
}>();

const emit = defineEmits<{ run: [action: ActionView, drafts: FormDrafts] }>();

const reportError = ref('');

async function choose(action: ActionView, drafts: FormDrafts): Promise<void> {
  if (action.request.method === 'POST') {
    emit('run', action, drafts);
    return;
  }
  reportError.value = '';
  try {
    await downloadReport(action.request.path, props.task.id);
  } catch (caught) {
    reportError.value = caught instanceof ApiError ? caught.message : String(caught);
  }
}
</script>

<template>
  <section aria-labelledby="decisions-heading" class="flex flex-col gap-3" data-panel="decisions">
    <h2 id="decisions-heading" class="text-base font-semibold text-highlighted">Decisions</h2>
    <p v-if="!decisions.length" class="text-sm text-muted">
      Nothing needs your decision. {{ task.header.nextStep.label }}
    </p>
    <DecisionCard
      v-for="action in decisions"
      :key="action.id"
      :action="action"
      :busy="busy"
      :sending="sending === action.id"
      :issues="issuesFor(action.id)"
      @run="drafts => choose(action, drafts)"
    >
      <template v-if="action.id === 'approve'">
        <p>
          You approve plan version {{ task.details.approval.version }} with digest
          <code class="font-mono text-xs" :title="task.details.approval.digest">{{
            short(task.details.approval.digest)
          }}</code>
          exactly as shown under Details. Check its outcome, criteria, files, commands and expected output first.
        </p>
      </template>
      <template v-else-if="action.id === 'authorize' && task.details.scope">
        <ScopeReview :scope="task.details.scope" />
      </template>
    </DecisionCard>
    <p v-if="reportError" role="alert" class="text-sm text-error">{{ reportError }}</p>
  </section>
</template>
