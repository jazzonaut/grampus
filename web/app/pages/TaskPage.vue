<!-- One task: its pipeline, the decision it waits for, and its evidence in tabs. -->
<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import EventLog from '../components/EventLog.vue';
import MarkdownView from '../components/MarkdownView.vue';
import PipelineStrip from '../components/PipelineStrip.vue';
import StatusIcon from '../components/StatusIcon.vue';
import TimelineList from '../components/TimelineList.vue';
import { useNow } from '../composables/useNow';
import { useTask } from '../composables/useTask';
import { ago, shortSha, statusLook, when } from '../presentation';

const props = defineProps<{ id: string }>();
const { task, error } = useTask(toRef(props, 'id'));
const now = useNow();

const tab = ref('overview');
const tabs = computed(() => [
  { label: 'Overview', value: 'overview', icon: 'i-lucide-layout-dashboard' },
  { label: 'Timeline', value: 'timeline', icon: 'i-lucide-history' },
  { label: 'Events', value: 'events', icon: 'i-lucide-scroll-text' },
]);
</script>

<template>
  <UDashboardPanel id="task" class="min-w-0">
    <template #header>
      <UDashboardNavbar :title="task?.title ?? 'Loading...'" :toggle="false">
        <template #leading>
          <UButton
            to="/"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            class="lg:hidden"
            aria-label="Back to tasks"
          />
        </template>
        <template #right>
          <UBadge v-if="task" :color="statusLook[task.status].color" variant="subtle" class="gap-1.5">
            <StatusIcon :look="statusLook[task.status]" size="size-3.5" />
            <span class="max-sm:hidden">{{ statusLook[task.status].label }}</span>
          </UBadge>
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar v-if="task">
        <PipelineStrip :steps="task.pipeline" />
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
      <div v-else-if="!task" class="space-y-3">
        <USkeleton class="h-6 w-1/2" />
        <USkeleton class="h-24 w-full" />
      </div>
      <div v-else class="space-y-5 max-w-5xl">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span class="inline-flex items-center gap-1.5"
            ><UIcon name="i-lucide-folder-git-2" class="size-4" />{{ task.repository.name }}</span
          >
          <span class="inline-flex items-center gap-1.5"
            ><UIcon name="i-lucide-chef-hat" class="size-4" />{{ task.recipe }}</span
          >
          <span class="inline-flex items-center gap-1.5" :title="when(task.createdAt)"
            ><UIcon name="i-lucide-clock" class="size-4" />started {{ ago(task.createdAt, now) }}</span
          >
          <span v-if="task.worktree" class="font-mono text-xs"
            >{{ task.taskId }} · base {{ shortSha(task.worktree.baseSha) }}</span
          >
        </div>

        <UTabs v-model="tab" :items="tabs" variant="link" :content="false" class="w-full overflow-x-auto" />

        <section v-if="tab === 'overview'" class="space-y-4">
          <UCard>
            <template #header>
              <h3 class="font-semibold flex items-center gap-2">
                <UIcon name="i-lucide-message-square-quote" class="size-4" /> Request
              </h3>
            </template>
            <MarkdownView :source="task.request" />
          </UCard>
          <p class="text-sm text-muted">{{ task.phase }}</p>
        </section>
        <TimelineList v-else-if="tab === 'timeline'" :items="task.timeline" />
        <EventLog v-else-if="tab === 'events'" :task-id="task.taskId" :updated-at="task.updatedAt" />
      </div>
    </template>
  </UDashboardPanel>
</template>
