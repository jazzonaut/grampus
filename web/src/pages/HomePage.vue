<script setup lang="ts">
/**
 * HomePage: the overview (`OverviewV1`, polled by App): integration health, the "Needs your attention"
 * queue first, with the safe actions that resolve each item, active tasks, planning conversations, recent
 * verified deliveries and how many guided tasks are running against the limit.
 *
 * Props:
 * - `overview`: the latest overview, or undefined while the first one loads.
 * - `refresh`: fetches the overview again, after an action.
 */
import { computed, ref } from 'vue';
import type { ActionView, AttentionItem, OverviewV1 } from '../../../src/server/api-types';
import { useActions } from '../api/useActions';
import { href } from '../router';
import ActionNoticeBar from '../components/ActionNoticeBar.vue';
import AttentionPanel from '../components/AttentionPanel.vue';
import EmptyState from '../components/EmptyState.vue';
import OverviewStats from '../components/OverviewStats.vue';
import HealthSummaryBar from '../components/HealthSummaryBar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TaskSummaryItem from '../components/TaskSummaryItem.vue';
import { localTime, short } from '../components/format';

defineOptions({ name: 'HomePage' });

const props = defineProps<{ overview: OverviewV1 | undefined; refresh: () => Promise<void> }>();

const chosenItem = ref<string | null>(null);

const actions = useActions({
  refresh: () => props.refresh(),
  signature: () =>
    props.overview
      ? [
          props.overview.revision,
          props.overview.attention
            .map(item => `${item.id}:${item.actions.map(a => `${a.id}:${a.expected ?? ''}`).join()}`)
            .join(','),
          props.overview.tasks.map(task => `${task.id}:${task.status}`).join(','),
        ].join('|')
      : undefined,
});

function run(item: AttentionItem, action: ActionView): void {
  chosenItem.value = item.id;
  void actions.run(action);
}

const sending = computed(() =>
  actions.sending.value && chosenItem.value ? { itemId: chosenItem.value, actionId: actions.sending.value } : null,
);
</script>

<template>
  <div class="grampus-page">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-3xl font-semibold tracking-tight text-highlighted">Your workspace</h1>
        <p class="mt-2 text-sm text-muted">Plans, decisions and verified local delivery.</p>
      </div>
      <div class="flex items-center gap-3">
        <p v-if="overview?.pool" class="text-sm text-muted" data-pool>
          {{ overview.pool.running }} of {{ overview.pool.limit }} guided tasks running
        </p>
        <a
          :href="href({ name: 'new' })"
          class="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-inverted hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          New task
        </a>
      </div>
    </div>
    <p v-if="!overview" class="text-sm text-muted" role="status">Loading the overview…</p>
    <template v-else>
      <AttentionPanel :items="overview.attention" :busy="actions.busy.value" :sending="sending" @run="run" />
      <ActionNoticeBar :notice="actions.notice.value" @dismiss="actions.dismiss()" />
      <OverviewStats :overview="overview" />
      <section aria-labelledby="tasks-heading" class="min-w-0 rounded-xl border border-default bg-default">
        <h2 id="tasks-heading" class="px-4 pt-3 pb-2 font-semibold text-highlighted">
          Tasks ({{ overview.tasks.length }})
        </h2>
        <ul v-if="overview.tasks.length" class="divide-y divide-default border-t border-default">
          <TaskSummaryItem v-for="task in overview.tasks" :key="task.id" :task="task" />
        </ul>
        <div v-else class="border-t border-default p-4">
          <EmptyState
            title="No tasks yet"
            description="Choose New task to describe a change. Grampus plans it with you before any work starts."
          >
            <template #actions><a :href="href({ name: 'new' })" class="grampus-link-button">Start a task</a></template>
          </EmptyState>
        </div>
      </section>
      <div class="grid items-start gap-5 xl:grid-cols-2">
        <section aria-labelledby="planning-heading" class="min-w-0 rounded-xl border border-default bg-default">
          <h2 id="planning-heading" class="px-4 pt-3 pb-2 font-semibold text-highlighted">
            Planning ({{ overview.planning.length }})
          </h2>
          <ul v-if="overview.planning.length" class="divide-y divide-default border-t border-default">
            <li
              v-for="item in overview.planning"
              :key="item.id"
              class="flex flex-wrap items-center gap-2 px-4 py-3"
              :data-kickoff="item.id"
            >
              <a
                :href="href({ name: 'planning', id: item.id })"
                class="font-medium text-highlighted underline-offset-2 hover:underline"
                >{{ item.title }}</a
              >
              <StatusBadge :status="item.status" :label="item.statusLabel" size="sm" />
              <span class="text-xs text-muted">{{ item.repository.name }} · {{ item.provider.label }}</span>
            </li>
          </ul>
          <p v-else class="border-t border-default px-4 py-3 text-sm text-muted">
            No planning conversations in progress.
          </p>
        </section>
        <section aria-labelledby="deliveries-heading" class="min-w-0 rounded-xl border border-default bg-default">
          <h2 id="deliveries-heading" class="px-4 pt-3 pb-2 font-semibold text-highlighted">
            Recent verified deliveries
          </h2>
          <ul v-if="overview.recentDeliveries.length" class="divide-y divide-default border-t border-default">
            <li
              v-for="delivery in overview.recentDeliveries"
              :key="`${delivery.taskId}:${delivery.slice.index}`"
              class="flex flex-col gap-1 px-4 py-3 text-sm"
            >
              <p class="flex flex-wrap items-center gap-2">
                <StatusBadge status="verified" size="sm" />
                <a
                  :href="href({ name: 'task', id: delivery.taskId })"
                  class="font-medium text-highlighted hover:underline"
                  >{{ delivery.taskTitle }}</a
                >
                <span class="text-xs text-muted">Slice {{ delivery.slice.index }} of {{ delivery.slice.count }}</span>
              </p>
              <p class="text-xs text-toned">
                <template v-if="delivery.commit"
                  >Commit <code class="font-mono">{{ short(delivery.commit) }}</code></template
                >
                <template v-else>Verified with no change</template>
                · {{ localTime(delivery.deliveredAt) }} · {{ delivery.evidence }}
              </p>
            </li>
          </ul>
          <p v-else class="border-t border-default px-4 py-3 text-sm text-muted">
            Nothing delivered yet. Deliveries are local commits verified by Grampus.
          </p>
        </section>
      </div>
      <HealthSummaryBar :health="overview.health" />
    </template>
  </div>
</template>
