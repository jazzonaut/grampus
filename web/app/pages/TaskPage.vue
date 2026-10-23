<!--
  One task. The header keeps where it stands in view: title, repository and base, the pipeline and the
  tabs. The decision it waits for is on the overview, which the tab marks while one is pending.
-->
<script setup lang="ts">
import { computed, toRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import EventLog from '../components/EventLog.vue';
import ChangesTab from '../components/ChangesTab.vue';
import MessagesTab from '../components/MessagesTab.vue';
import OverviewTab from '../components/OverviewTab.vue';
import PipelineStrip from '../components/PipelineStrip.vue';
import ReplyForm from '../components/ReplyForm.vue';
import RoundsTab from '../components/RoundsTab.vue';
import ScorecardTab from '../components/ScorecardTab.vue';
import SpecTab from '../components/SpecTab.vue';
import StatusIcon from '../components/StatusIcon.vue';
import TaskMenu from '../components/TaskMenu.vue';
import TimelineList from '../components/TimelineList.vue';
import { useNow } from '../composables/useNow';
import { useTask } from '../composables/useTask';
import { ago, shortSha, statusLook, when } from '../presentation';

const props = defineProps<{ id: string }>();
const { task, error } = useTask(toRef(props, 'id'));
const now = useNow();

// The open tab lives in the address (?tab=spec), so it survives reloads and can be bookmarked.
const route = useRoute();
const router = useRouter();
const tab = computed({
  get: () => (typeof route.query['tab'] === 'string' ? route.query['tab'] : 'overview'),
  set: value => void router.replace({ query: value === 'overview' ? {} : { tab: value } }),
});

const tabs = computed(() => {
  const open = task.value?.summary.questions.length ?? 0;
  const latest = task.value?.specs.at(-1);
  return [
    {
      label: 'Overview',
      value: 'overview',
      icon: 'i-lucide-layout-dashboard',
      badge: task.value?.needsYou
        ? { icon: 'i-lucide-hand', color: 'warning' as const, variant: 'subtle' as const }
        : undefined,
    },
    { label: 'Spec', value: 'spec', icon: 'i-lucide-file-text', badge: latest ? `v${latest.version}` : undefined },
    { label: 'Changes', value: 'changes', icon: 'i-lucide-file-diff' },
    { label: 'Checks & review', value: 'rounds', icon: 'i-lucide-list-checks' },
    {
      label: 'Questions',
      value: 'messages',
      icon: 'i-lucide-messages-square',
      badge: open ? { label: String(open), color: 'warning' as const } : undefined,
    },
    { label: 'Timeline', value: 'timeline', icon: 'i-lucide-history' },
    { label: 'Scorecard', value: 'scorecard', icon: 'i-lucide-gauge' },
    { label: 'Events', value: 'events', icon: 'i-lucide-scroll-text' },
  ];
});
</script>

<template>
  <UDashboardPanel id="task" class="min-w-0">
    <template #header>
      <header class="px-4 sm:px-6 pt-3 space-y-3">
        <div class="flex items-start gap-2">
          <UButton
            to="/"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            class="lg:hidden -ml-2"
            aria-label="Back to tasks"
          />
          <h1 class="flex-1 min-w-0 text-lg font-semibold text-highlighted line-clamp-2" :title="task?.title">
            {{ task?.title ?? 'Loading...' }}
          </h1>
          <div v-if="task" class="flex items-center gap-1.5 shrink-0">
            <UBadge :color="statusLook[task.status].color" variant="subtle" class="gap-1.5">
              <StatusIcon :look="statusLook[task.status]" size="size-3.5" />
              <span class="max-sm:hidden">{{ statusLook[task.status].label }}</span>
            </UBadge>
            <TaskMenu :task="task" />
          </div>
        </div>
        <template v-if="task">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span class="inline-flex items-center gap-1.5" :title="task.repository.path">
              <UIcon name="i-lucide-folder-git-2" class="size-4" />{{ task.repository.name }}
            </span>
            <span class="inline-flex items-center gap-1.5">
              <UIcon name="i-lucide-chef-hat" class="size-4" />{{ task.recipe }}
            </span>
            <span class="inline-flex items-center gap-1.5" :title="when(task.createdAt)">
              <UIcon name="i-lucide-clock" class="size-4" />started {{ ago(task.createdAt, now) }}
            </span>
            <span v-if="task.worktree" class="font-mono text-xs">
              {{ task.taskId }} · base {{ shortSha(task.worktree.baseSha) }}
            </span>
            <RouterLink
              v-if="task.comparisonId"
              :to="`/comparisons/${task.comparisonId}`"
              class="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              <UIcon name="i-lucide-git-compare-arrows" class="size-4" />Part of a comparison
            </RouterLink>
          </div>
          <PipelineStrip :steps="task.pipeline" />
          <UTabs
            v-model="tab"
            :items="tabs"
            variant="link"
            :content="false"
            class="overflow-x-auto -mx-4 sm:-mx-6 px-4 sm:px-6"
            :ui="{ trigger: 'grow-0 shrink-0', label: 'overflow-visible' }"
          />
        </template>
      </header>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
      <div v-else-if="!task" class="space-y-3">
        <USkeleton class="h-6 w-1/2" />
        <USkeleton class="h-24 w-full" />
      </div>
      <div v-else class="max-w-7xl">
        <OverviewTab v-if="tab === 'overview'" :task="task" @show="value => (tab = value)" />
        <SpecTab v-else-if="tab === 'spec'" :specs="task.specs" />
        <ChangesTab v-else-if="tab === 'changes'" :task="task" />
        <RoundsTab v-else-if="tab === 'rounds'" :task="task" />
        <MessagesTab v-else-if="tab === 'messages'" :messages="task.messages">
          <template #reply="{ message }">
            <ReplyForm
              :task-id="task.taskId"
              :message="message"
              :queued="
                task.commands.some(command => command.state === 'queued' && command.messageId === message.messageId)
              "
            />
          </template>
        </MessagesTab>
        <TimelineList v-else-if="tab === 'timeline'" :items="task.timeline" />
        <ScorecardTab v-else-if="tab === 'scorecard'" :task-id="task.taskId" :finished="task.finished !== null" />
        <EventLog v-else-if="tab === 'events'" :task-id="task.taskId" :updated-at="task.updatedAt" />
      </div>
    </template>
  </UDashboardPanel>
</template>
