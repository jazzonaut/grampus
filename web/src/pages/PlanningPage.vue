<script setup lang="ts">
/**
 * PlanningPage: one planning conversation (`GET /api/v1/kickoffs/:id`, polled while visible): the
 * discussion, pending questions with suggested answers, a message to refine the plan, the proposal with
 * Review for approval, live planner progress with stop and recovery, file hints and reference folders,
 * and reset or delete. Every action is the server's `ActionView`, sent with the turn key it was shown for.
 *
 * Props:
 * - `id`: the planning conversation id.
 */
import { computed, watch } from 'vue';
import type { ActionView, KickoffDetailV1 } from '../../../src/server/api-types';
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
import DiscussionThread from '../components/DiscussionThread.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import NoticeBox from '../components/NoticeBox.vue';
import PlanCard from '../components/PlanCard.vue';
import PlanningContext from '../components/PlanningContext.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { localTime, short } from '../components/format';

defineOptions({ name: 'PlanningPage' });

const props = defineProps<{ id: string }>();

const kickoff = usePolled(() => get<KickoffDetailV1>(`/api/v1/kickoffs/${props.id}`), pollIntervalMs, {
  enabled: () => !needsAccessLink.value,
});
const view = computed(() => kickoff.data.value);
const missing = computed(() => kickoff.error.value?.status === 404);

const signature = (): string | undefined => {
  const current = view.value;
  if (!current) return undefined;
  return [
    current.revision,
    current.status,
    current.statusLabel,
    current.taskId ?? '',
    current.actions.map(item => `${item.id}:${item.expected ?? ''}:${String(item.enabled)}`).join(','),
  ].join('|');
};

const actions = useActions({
  refresh: () => kickoff.refresh(),
  signature,
  accepted: (action, response) => {
    const created = typeof response === 'object' && response !== null && 'id' in response ? String(response.id) : null;
    if (action.id === 'prepare' && created) navigate({ name: 'task', id: created });
    if (action.id === 'reset' && created) navigate({ name: 'planning', id: created });
    if (action.id === 'delete') navigate({ name: 'home' });
  },
});

const find = (id: ActionView['id']) => computed(() => view.value?.actions.find(item => item.id === id));
const stop = find('stop-planning');
const recover = find('recover-planning');
const answer = find('plan-answer');
const message = find('plan-message');
const prepare = find('prepare');
const lifecycle = computed(() => view.value?.actions.filter(item => item.id === 'reset' || item.id === 'delete') ?? []);

function run(action: ActionView | undefined, drafts = {}): void {
  if (action) void actions.run(action, drafts);
}

watch(
  () => view.value?.statusLabel,
  (label, previous) => {
    if (label && previous && label !== previous) announce(`Planning status: ${label}`);
  },
);
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <a :href="href({ name: 'home' })" class="text-sm text-muted hover:underline">← Overview</a>
    <EmptyState
      v-if="missing"
      title="This planning conversation is not available"
      description="It may have been deleted or reset."
      icon="i-lucide-file-question"
    >
      <template #actions><a :href="href({ name: 'home' })" class="grampus-link-button">Back to overview</a></template>
    </EmptyState>
    <ErrorBanner
      v-else-if="kickoff.error.value && !view"
      :message="kickoff.error.value.message"
      retry-label="Try again"
      @retry="kickoff.refresh()"
    />
    <p v-else-if="!view" class="text-sm text-muted" role="status">Loading the planning conversation…</p>
    <template v-if="view && !missing">
      <header class="flex flex-col gap-2">
        <p class="text-xs font-medium tracking-wide text-muted uppercase">
          Planning conversation · {{ view.repository.name }}
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-semibold text-highlighted">{{ view.title }}</h1>
          <StatusBadge :status="view.status" :label="view.statusLabel" size="lg" />
        </div>
        <p class="text-base text-default" data-explanation>{{ view.explanation }}</p>
      </header>
      <ActionNoticeBar :notice="actions.notice.value" @dismiss="actions.dismiss()" />
      <NoticeBox v-if="view.taskId" tone="success" title="This plan is now a task">
        Inspect and approve it on the task page.
        <template #actions
          ><a :href="href({ name: 'task', id: view.taskId })" class="grampus-link-button">Open task</a></template
        >
      </NoticeBox>
      <NoticeBox v-if="view.error" tone="error" title="The planner's last reply was not usable" live="alert">
        <p class="whitespace-pre-line">{{ view.error }}</p>
      </NoticeBox>
      <NoticeBox v-if="view.actionError" tone="error" title="A dashboard action failed">
        <p>{{ view.actionError.message }}</p>
        <p v-if="view.actionError.at" class="text-xs text-muted">
          {{ view.actionError.action }} · {{ localTime(view.actionError.at) }}
        </p>
      </NoticeBox>
      <ActivityCard v-if="view.activity" :activity="view.activity" heading="Planning progress">
        <template v-if="stop" #actions>
          <ActionButton
            :action="stop"
            :busy="actions.busy.value"
            :sending="actions.sending.value === stop.id"
            show-description
            @run="run(stop)"
          />
        </template>
      </ActivityCard>
      <DecisionCard
        v-if="recover"
        :action="recover"
        :busy="actions.busy.value"
        :sending="actions.sending.value === recover.id"
        @run="run(recover)"
      />
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="flex min-w-0 flex-col gap-4">
          <DiscussionThread :messages="view.messages" :request="view.request" />
          <DecisionCard
            v-if="answer"
            :action="answer"
            :busy="actions.busy.value"
            :sending="actions.sending.value === answer.id"
            :issues="actions.issuesFor(answer.id)"
            @run="drafts => run(answer, drafts)"
          />
          <section
            v-if="view.proposal"
            aria-labelledby="proposal-heading"
            class="flex flex-col gap-3 rounded-lg border border-primary/30 p-4"
          >
            <h2 id="proposal-heading" class="text-base font-semibold text-highlighted">Proposal</h2>
            <p class="text-xs text-muted">
              Proposal digest
              <code class="font-mono" :title="view.proposal.digest">{{ short(view.proposal.digest) }}</code>
            </p>
            <DecisionCard
              v-if="prepare"
              :action="prepare"
              :busy="actions.busy.value"
              :sending="actions.sending.value === prepare.id"
              @run="run(prepare)"
            />
            <PlanCard :plan="view.proposal.plan" heading="The proposed plan" />
          </section>
          <DecisionCard
            v-if="message"
            :action="message"
            :busy="actions.busy.value"
            :sending="actions.sending.value === message.id"
            :issues="actions.issuesFor(message.id)"
            @run="drafts => run(message, drafts)"
          />
        </div>
        <aside class="flex flex-col gap-4" aria-label="Planning context">
          <PlanningContext
            :kickoff="view"
            :busy="actions.busy.value"
            :sending="actions.sending.value"
            :issues-for="actions.issuesFor"
            @run="run"
          />
          <section
            v-if="lifecycle.length"
            aria-labelledby="manage-heading"
            class="flex flex-col gap-3 rounded-lg border border-default p-4"
          >
            <h2 id="manage-heading" class="text-base font-semibold text-highlighted">Manage</h2>
            <ActionButton
              v-for="action in lifecycle"
              :key="action.id"
              :action="action"
              :busy="actions.busy.value"
              :sending="actions.sending.value === action.id"
              show-description
              @run="run(action)"
            />
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>
