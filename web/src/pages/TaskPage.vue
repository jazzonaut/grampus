<script setup lang="ts">
/**
 * TaskPage: one task (`GET /api/v1/tasks/:id`, polled while visible): the summary header, the workflow
 * strip, current activity, the decision queue, results, usage, details on demand, plan revision and task
 * management. Every action is the server's `ActionView`, sent unchanged with its decision key.
 *
 * Props:
 * - `id`: the task id.
 */
import { computed, watch } from 'vue';
import type { ActionView, TaskDetailV1 } from '../../../src/server/api-types';
import { get, needsAccessLink } from '../api/client';
import { useActions } from '../api/useActions';
import { usePolled } from '../api/usePolled';
import { announce } from '../announcer';
import { href, navigate } from '../router';
import { pollIntervalMs } from '../settings';
import ActionButton from '../components/ActionButton.vue';
import ActionNoticeBar from '../components/ActionNoticeBar.vue';
import ActivityCard from '../components/ActivityCard.vue';
import DecisionCard from '../components/DecisionCard.vue';
import DecisionQueue from '../components/DecisionQueue.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import EvidenceSection from '../components/EvidenceSection.vue';
import ResultsPanel from '../components/ResultsPanel.vue';
import TaskDetails from '../components/TaskDetails.vue';
import TaskHeader from '../components/TaskHeader.vue';
import UsagePanel from '../components/UsagePanel.vue';
import WorkflowStrip from '../components/WorkflowStrip.vue';

defineOptions({ name: 'TaskPage' });

const props = defineProps<{ id: string }>();

const task = usePolled(() => get<TaskDetailV1>(`/api/v1/tasks/${props.id}`), pollIntervalMs, {
  enabled: () => !needsAccessLink.value,
});

const view = computed(() => task.data.value);
const missing = computed(() => task.error.value?.status === 404);

/** What the decisions were chosen on; "requested" ends when it changes. */
const signature = (): string | undefined => {
  const current = view.value;
  if (!current) return undefined;
  const { header, decisions } = current;
  return [
    current.revision,
    header.status,
    header.statusLabel,
    header.actionError?.at ?? '',
    decisions.map(item => `${item.id}:${item.expected ?? ''}:${String(item.enabled)}`).join(','),
  ].join('|');
};

const actions = useActions({
  refresh: () => task.refresh(),
  signature,
  accepted: (action, response) => {
    if (action.id === 'delete') navigate({ name: 'home' });
    if (action.id === 'reset' && typeof response === 'object' && response !== null && 'id' in response)
      navigate({ name: 'planning', id: String(response.id) });
  },
});

const managed = new Set(['revise', 'reset', 'delete']);
const decisions = computed(() => view.value?.decisions ?? []);
const stop = computed(() => decisions.value.find(item => item.id === 'stop'));
/** The report is a decision only when it is the next step (a delivered task); otherwise it is under Details. */
const reportIsNext = computed(() => {
  const step = view.value?.header.nextStep;
  return step?.kind === 'human' && step.actionIds.includes('report');
});
const queue = computed(() =>
  decisions.value.filter(
    item =>
      !managed.has(item.id) &&
      !(item.id === 'stop' && view.value?.activity) &&
      !(item.id === 'report' && !reportIsNext.value),
  ),
);
const revise = computed(() => decisions.value.find(item => item.id === 'revise'));
const lifecycle = computed(() => decisions.value.filter(item => item.id === 'reset' || item.id === 'delete'));

function run(action: ActionView, drafts = {}): void {
  void actions.run(action, drafts);
}

watch(
  () => view.value?.header.statusLabel,
  (label, previous) => {
    if (label && previous && label !== previous) announce(`Task status: ${label}`);
  },
);
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6">
    <a :href="href({ name: 'home' })" class="text-sm text-muted hover:underline">← Overview</a>
    <EmptyState
      v-if="missing"
      title="This task is not available"
      description="It may have been deleted or reset. Its workspace files, commits and history are kept."
      icon="i-lucide-file-question"
    >
      <template #actions><a :href="href({ name: 'home' })" class="grampus-link-button">Back to overview</a></template>
    </EmptyState>
    <ErrorBanner
      v-else-if="task.error.value && !view"
      :message="task.error.value.message"
      retry-label="Try again"
      @retry="task.refresh()"
    />
    <p v-else-if="!view" class="text-sm text-muted" role="status">Loading the task…</p>
    <template v-if="view && !missing">
      <TaskHeader :header="view.header" />
      <ActionNoticeBar :notice="actions.notice.value" @dismiss="actions.dismiss()" />
      <section aria-labelledby="workflow-heading" class="flex flex-col gap-2">
        <h2 id="workflow-heading" class="text-base font-semibold text-highlighted">Workflow</h2>
        <WorkflowStrip :stages="view.workflow" />
      </section>
      <ActivityCard v-if="view.activity" :activity="view.activity">
        <template v-if="stop" #actions>
          <ActionButton
            :action="stop"
            :busy="actions.busy.value"
            :sending="actions.sending.value === 'stop'"
            show-description
            @run="run(stop)"
          />
        </template>
      </ActivityCard>
      <DecisionQueue
        :decisions="queue"
        :task="view"
        :busy="actions.busy.value"
        :sending="actions.sending.value"
        :issues-for="actions.issuesFor"
        @run="run"
      />
      <ResultsPanel :results="view.results" />
      <UsagePanel :usage="view.usage" />
      <TaskDetails :task="view" />
      <EvidenceSection
        v-if="revise"
        :title="revise.label"
        :summary="revise.enabled ? 'Needs fresh approval' : 'Unavailable now'"
      >
        <DecisionCard
          :action="revise"
          :busy="actions.busy.value"
          :sending="actions.sending.value === 'revise'"
          :issues="actions.issuesFor('revise')"
          @run="drafts => revise && run(revise, drafts)"
        />
      </EvidenceSection>
      <section
        v-if="lifecycle.length"
        aria-labelledby="manage-heading"
        class="flex flex-col gap-2 rounded-lg border border-default p-4"
      >
        <h2 id="manage-heading" class="text-base font-semibold text-highlighted">Manage task</h2>
        <div class="flex flex-wrap gap-4">
          <ActionButton
            v-for="action in lifecycle"
            :key="action.id"
            :action="action"
            :busy="actions.busy.value"
            :sending="actions.sending.value === action.id"
            show-description
            @run="run(action)"
          />
        </div>
      </section>
    </template>
  </div>
</template>
