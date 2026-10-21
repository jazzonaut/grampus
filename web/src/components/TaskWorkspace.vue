<script setup lang="ts">
/** Owns execution workspace navigation; evidence panels fetch only when their view is opened. */
import type { TaskDetailV1 } from '../../../src/server/api-types';
import ResultsPanel from './ResultsPanel.vue';
import UsagePanel from './UsagePanel.vue';
import TaskDetails from './TaskDetails.vue';
import PlanCard from './PlanCard.vue';
import ViewTabs from './ViewTabs.vue';
import LiveChanges from './LiveChanges.vue';
import TaskRunMetrics from './TaskRunMetrics.vue';
import SpendingPanel from './SpendingPanel.vue';
import RepairDecisions from './RepairDecisions.vue';
defineProps<{ task: TaskDetailV1 }>();
const selected = defineModel<string>({ required: true });
const tabs = [
  { id: 'results', label: 'Results and checks' },
  { id: 'changes', label: 'Changes' },
  { id: 'plan', label: 'Plan' },
  { id: 'usage', label: 'Usage' },
  { id: 'details', label: 'Activity and evidence' },
];
defineSlots<{ approval?: () => unknown; spending?: () => unknown }>();
</script>

<template>
  <ViewTabs v-model="selected" :items="tabs" label="Task views">
    <ResultsPanel v-if="selected === 'results'" :results="task.results" />
    <div v-else-if="selected === 'plan'" class="flex flex-col gap-5">
      <PlanCard
        :plan="task.details.plan"
        :heading="task.details.approval.approved ? 'Approved plan' : 'Plan for approval'"
      />
      <slot name="approval" />
    </div>
    <div v-else-if="selected === 'changes'">
      <LiveChanges v-if="task.liveChangesPath" :path="task.liveChangesPath" :interval-ms="task.liveChangesIntervalMs" />
      <p v-else class="text-sm text-muted">The task workspace is not available yet.</p>
    </div>
    <div v-else-if="selected === 'usage'" class="flex flex-col gap-5">
      <SpendingPanel :spending="task.spending"><slot name="spending" /></SpendingPanel>
      <RepairDecisions :repairs="task.repairs" />
      <UsagePanel :usage="task.usage" />
      <TaskRunMetrics :id="task.id" />
    </div>
    <TaskDetails v-else :task="task" />
  </ViewTabs>
</template>
