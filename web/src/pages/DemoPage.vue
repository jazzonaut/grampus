<script setup lang="ts">
/**
 * DemoPage: every shared component rendered with mock data (mock.ts), so the shell and its
 * building blocks can be checked visually in light and dark mode before real screens exist.
 *
 * Props:
 * - `connection`: the live server connection status for the header health indicator.
 * - `connectionLabel`: text for that indicator.
 * - `accessRequired`: show the access-link banner (the server refused the token).
 * - `version`: version line for the footer, when the server reported one.
 *
 * Actions only update the page and the screen-reader announcement; nothing is sent.
 */
import { computed, ref } from 'vue';
import AppShell from '../components/AppShell.vue';
import AttentionPanel from '../components/AttentionPanel.vue';
import DecisionCard from '../components/DecisionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import EvidenceSection from '../components/EvidenceSection.vue';
import LogViewer from '../components/LogViewer.vue';
import MarkdownView from '../components/MarkdownView.vue';
import StatusBadge from '../components/StatusBadge.vue';
import UsageSummary from '../components/UsageSummary.vue';
import WorkflowStrip from '../components/WorkflowStrip.vue';
import type { ActionChoice } from '../components/types';
import { accessMessage } from '../api/client';
import { statuses } from '../theme/status';
import type { Status } from '../theme/status';
import {
  mockAttention,
  mockDecision,
  mockLogPages,
  mockPlanMarkdown,
  mockStages,
  mockTasks,
  mockUsageProviders,
  mockUsageStages,
} from '../mock';

defineOptions({ name: 'DemoPage' });

withDefaults(
  defineProps<{ connection: Status; connectionLabel: string; accessRequired?: boolean; version?: string }>(),
  { accessRequired: false, version: '' },
);

const selected = ref(mockTasks[0]?.id ?? '');
const announcement = ref('');
const loadedPages = ref(1);
const showSampleError = ref(true);

const logText = computed(() => mockLogPages.slice(0, loadedPages.value).join('\n'));

function onAttention(choice: ActionChoice): void {
  const item = mockAttention.find(entry => entry.id === choice.itemId);
  const action = item?.actions.find(entry => entry.id === choice.actionId);
  announcement.value = `${action?.label ?? choice.actionId} chosen for ${item?.title ?? choice.itemId} (demo, nothing sent)`;
}

function onDecision(choice: { actionId: string; expected: string | null }): void {
  const action = mockDecision.actions.find(entry => entry.id === choice.actionId);
  announcement.value = `${action?.label ?? choice.actionId} chosen with decision key ${choice.expected ?? 'none'} (demo, nothing sent)`;
}

function select(id: string): void {
  selected.value = id;
  const task = mockTasks.find(entry => entry.id === id);
  if (task) announcement.value = `Selected ${task.title}`;
}
</script>

<template>
  <AppShell :announcement="announcement">
    <template #health>
      <StatusBadge :status="connection" :label="connectionLabel" size="sm" />
    </template>

    <template #sidebar>
      <h2 class="px-2 pb-2 text-xs font-medium tracking-wide text-muted uppercase">Tasks</h2>
      <ul class="flex flex-col gap-1">
        <li v-for="task in mockTasks" :key="task.id">
          <button
            type="button"
            :aria-current="selected === task.id ? 'true' : undefined"
            :class="[
              'flex w-full flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary',
              selected === task.id ? 'bg-elevated font-medium text-highlighted' : 'text-default',
            ]"
            @click="select(task.id)"
          >
            <span>{{ task.title }}</span>
            <StatusBadge :status="task.status" size="sm" />
          </button>
        </li>
      </ul>
    </template>

    <div class="mx-auto flex max-w-5xl flex-col gap-6">
      <header class="flex flex-col gap-1">
        <p class="text-xs font-medium tracking-wide text-muted uppercase">Component gallery · mock data</p>
        <h1 class="text-xl font-semibold text-highlighted">Add retry to the export job</h1>
      </header>

      <ErrorBanner v-if="accessRequired" kind="access" :message="accessMessage" />
      <ErrorBanner
        v-if="showSampleError"
        title="Sample error"
        message="Task changed since you inspected it; refresh before taking this action"
        retry-label="Refresh"
        dismissible
        @retry="announcement = 'Refreshed (demo)'"
        @dismiss="showSampleError = false"
      />

      <section aria-labelledby="statuses-heading" class="flex flex-col gap-2">
        <h2 id="statuses-heading" class="text-base font-semibold text-highlighted">Statuses</h2>
        <div class="flex flex-wrap gap-2">
          <StatusBadge v-for="status in statuses" :key="status" :status="status" />
        </div>
      </section>

      <section aria-labelledby="workflow-heading" class="flex flex-col gap-2">
        <h2 id="workflow-heading" class="text-base font-semibold text-highlighted">Workflow</h2>
        <WorkflowStrip :stages="mockStages" />
      </section>

      <div class="grid gap-6 lg:grid-cols-2">
        <DecisionCard :title="mockDecision.title" :actions="mockDecision.actions" @action="onDecision">
          <MarkdownView :source="mockPlanMarkdown" />
        </DecisionCard>
        <AttentionPanel :items="mockAttention" @action="onAttention" />
      </div>

      <div class="flex flex-col gap-3">
        <EvidenceSection title="Validation output" summary="3 checks, 1 failed" status="failed">
          <LogViewer
            label="stdout of npm test"
            :text="logText"
            :has-more="loadedPages < mockLogPages.length"
            @load-more="loadedPages += 1"
          />
        </EvidenceSection>
        <EvidenceSection
          title="Review findings"
          summary="Provider reported, not yet verified"
          status="provider_reported"
        >
          <MarkdownView source="**Low:** the retry delay is not capped. Consider a maximum of *30 s*." />
        </EvidenceSection>
      </div>

      <UsageSummary :providers="mockUsageProviders" :stages="mockUsageStages" />

      <EmptyState title="No retained changes yet" description="Changes appear here after implementation finishes." />
    </div>

    <template #footer>
      <span>{{ version || 'Version unknown (not connected)' }}</span>
    </template>
  </AppShell>
</template>
