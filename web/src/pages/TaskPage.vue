<script setup lang="ts">
/**
 * TaskPage: one task (`GET /api/v1/tasks/:id`, polled while visible): the summary header, the workflow
 * strip, current activity, the decision queue, results, usage, details on demand, plan revision and task
 * management. Every action is the server's `ActionView`, sent unchanged with its decision key.
 *
 * Props:
 * - `id`: the task id.
 */
import { computed, ref, useTemplateRef, watch } from 'vue';
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
import TaskWorkspace from '../components/TaskWorkspace.vue';
import TaskFacts from '../components/TaskFacts.vue';
import TaskHeader from '../components/TaskHeader.vue';
import WorkflowStrip from '../components/WorkflowStrip.vue';
import LiveChanges from '../components/LiveChanges.vue';
import RepairDecisions from '../components/RepairDecisions.vue';
import GuidancePanel from '../components/GuidancePanel.vue';
import SpendingPanel from '../components/SpendingPanel.vue';
import { short } from '../components/format';

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
const controls = computed(() => decisions.value.filter(item => item.id === 'stop' || item.id === 'pause'));
/** The report is a decision only when it is the next step (a delivered task); otherwise it is under Details. */
const reportIsNext = computed(() => {
  const step = view.value?.header.nextStep;
  return step?.kind === 'human' && step.actionIds.includes('report');
});
const queue = computed(() =>
  decisions.value.filter(
    item =>
      !managed.has(item.id) &&
      item.id !== 'approve' &&
      !((item.id === 'stop' || item.id === 'pause') && view.value?.activity) &&
      !(item.id === 'report' && !reportIsNext.value),
  ),
);
const approval = computed(() => decisions.value.find(item => item.id === 'approve'));
const selected = ref('results');
watch(
  () => view.value?.details.approval.approved,
  approved => {
    if (approved === false) selected.value = 'plan';
  },
);
const revise = computed(() => decisions.value.find(item => item.id === 'revise'));
const revisionIsNext = computed(() => {
  const step = view.value?.header.nextStep;
  return step?.kind === 'human' && step.actionIds.includes('revise');
});
const revisionPanel = useTemplateRef<HTMLDetailsElement>('revisionPanel');
function requestChanges(): void {
  const panel = revisionPanel.value;
  if (!panel) return;
  panel.open = true;
  panel.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}
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
  <div class="grampus-page">
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
      <div v-if="view.orca" class="flex flex-col items-start gap-2">
        <ActionButton
          :action="view.orca.open"
          :busy="actions.busy.value"
          :sending="actions.sending.value === view.orca.open.id"
          @run="run(view.orca.open)"
        />
        <p v-if="view.orca.problem" class="text-sm text-muted" role="status">{{ view.orca.problem }}</p>
      </div>
      <TaskFacts :task="view" />
      <ActionNoticeBar :notice="actions.notice.value" @dismiss="actions.dismiss()" />
      <section aria-labelledby="workflow-heading" class="flex flex-col gap-2">
        <h2 id="workflow-heading" class="text-base font-semibold text-highlighted">Workflow</h2>
        <WorkflowStrip :stages="view.workflow" />
      </section>
      <ActivityCard v-if="view.activity" :activity="view.activity">
        <template v-if="controls.length" #actions>
          <ActionButton
            v-for="control in controls"
            :key="control.id"
            :action="control"
            :busy="actions.busy.value"
            :sending="actions.sending.value === control.id"
            show-description
            @run="run(control)"
          />
        </template>
      </ActivityCard>
      <GuidancePanel :guidance="view.guidance" :refresh="task.refresh" />
      <DecisionQueue
        v-if="queue.length || !approval"
        :decisions="queue"
        :task="view"
        :busy="actions.busy.value"
        :sending="actions.sending.value"
        :issues-for="actions.issuesFor"
        @run="run"
      />
      <LiveChanges
        v-if="view.liveChangesPath"
        :key="view.id"
        :path="view.liveChangesPath"
        :interval-ms="view.liveChangesIntervalMs"
      />
      <RepairDecisions :repairs="view.repairs" />
      <SpendingPanel :spending="view.spending">
        <button
          v-if="revise && revisionIsNext"
          type="button"
          class="grampus-link-button self-start"
          @click="requestChanges"
        >
          {{ revise.label }}
        </button>
      </SpendingPanel>
      <TaskWorkspace v-model="selected" :task="view">
        <template #approval>
          <div
            v-if="approval"
            class="sticky bottom-3 flex flex-wrap items-center justify-end gap-4 rounded-xl border border-default bg-default p-4 shadow-sm"
            data-decision="approve"
          >
            <p class="mr-auto text-xs text-muted">
              Approve version {{ view.details.approval.version }} ·
              <code :title="view.details.approval.digest">{{ short(view.details.approval.digest) }}</code
              >. Inspect the file permissions and exact commands first.
            </p>
            <button v-if="revise" type="button" class="grampus-link-button" @click="requestChanges">
              Request changes
            </button>
            <ActionButton
              :action="approval"
              :busy="actions.busy.value"
              :sending="actions.sending.value === 'approve'"
              @run="run(approval)"
            />
          </div>
        </template>
      </TaskWorkspace>
      <details v-if="revise" ref="revisionPanel" class="rounded-xl border border-default bg-default p-4">
        <summary class="cursor-pointer text-sm font-medium text-highlighted">
          {{ revise.label }} · {{ revise.enabled ? 'Needs fresh approval' : 'Unavailable now' }}
        </summary>
        <DecisionCard
          class="mt-4"
          :action="revise"
          :busy="actions.busy.value"
          :sending="actions.sending.value === 'revise'"
          :issues="actions.issuesFor('revise')"
          @run="drafts => revise && run(revise, drafts)"
        />
      </details>
      <section
        v-if="lifecycle.length"
        aria-labelledby="manage-heading"
        class="flex flex-col gap-2 border-t border-default pt-4"
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
