<script setup lang="ts">
/**
 * PlanningPage: one planning conversation (`GET /api/v1/kickoffs/:id`, polled while visible): the
 * discussion, pending questions with suggested answers, a message to refine the plan, the proposal with
 * Create task for review, live planner progress with stop and recovery, file hints and reference folders,
 * and reset or delete. Every action is the server's `ActionView`, sent with the turn key it was shown for.
 *
 * Props:
 * - `id`: the planning conversation id.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
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
import PlanningComposer from '../components/PlanningComposer.vue';
import PlanningHeader from '../components/PlanningHeader.vue';
import PlanningResources from '../components/PlanningResources.vue';
import ViewTabs from '../components/ViewTabs.vue';
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
const selected = ref('conversation');
const page = useTemplateRef<HTMLElement>('page');
const tabs = computed(() => [
  { id: 'conversation', label: 'Conversation' },
  ...(view.value?.proposal ? [{ id: 'proposal', label: 'Proposal' }] : []),
]);
watch(
  () => view.value?.proposal,
  proposal => {
    if (!proposal) selected.value = 'conversation';
  },
);
async function requestChanges(): Promise<void> {
  selected.value = 'conversation';
  await nextTick();
  page.value
    ?.querySelector<HTMLTextAreaElement>(
      '[data-decision="plan-message"] textarea, [data-decision="plan-answer"] textarea',
    )
    ?.focus();
}

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
  <div ref="page" class="grampus-page">
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
      <PlanningHeader :kickoff="view" />
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
      <ViewTabs v-model="selected" :items="tabs" label="Planning views">
        <div v-show="selected === 'conversation'" class="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_31.5rem]">
          <div class="flex min-w-0 flex-col gap-5">
            <div class="max-h-[60vh] overflow-y-auto pr-2">
              <DiscussionThread :messages="view.messages" :request="view.request" />
            </div>
            <DecisionCard
              v-if="answer"
              :action="answer"
              :busy="actions.busy.value"
              :sending="actions.sending.value === answer.id"
              :issues="actions.issuesFor(answer.id)"
              @run="drafts => run(answer, drafts)"
            />
            <div class="sticky bottom-3 z-10 rounded-xl bg-default shadow-sm">
              <PlanningComposer
                v-if="message"
                :action="message"
                :busy="actions.busy.value"
                :sending="actions.sending.value === message.id"
                :issues="actions.issuesFor(message.id)"
                @run="drafts => run(message, drafts)"
              />
            </div>
          </div>
          <PlanningResources
            :kickoff="view"
            :busy="actions.busy.value"
            :sending="actions.sending.value"
            :issues-for="actions.issuesFor"
            @run="run"
            @proposal="selected = 'proposal'"
          />
        </div>
        <div v-if="selected === 'proposal' && view.proposal" class="flex flex-col gap-5">
          <p class="text-xs text-muted">
            Proposal digest
            <code class="font-mono" :title="view.proposal.digest">{{ short(view.proposal.digest) }}</code
            >. Creating a task does not approve or start it.
          </p>
          <PlanCard :plan="view.proposal.plan" heading="Review proposal" />
          <div
            class="sticky bottom-3 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-default bg-default p-4 shadow-sm"
          >
            <button type="button" class="grampus-link-button" @click="requestChanges">Request changes</button>
            <div v-if="prepare" :data-decision="prepare.id">
              <ActionButton
                :action="prepare"
                :busy="actions.busy.value"
                :sending="actions.sending.value === prepare.id"
                @run="run(prepare)"
              />
            </div>
          </div>
        </div>
      </ViewTabs>
    </template>
  </div>
</template>
