<!--
  The task list beside the selected task. On small screens only one of the two shows: the list, or the
  task with a back button.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { TaskStatus } from '../../../src/dashboard/types';
import TaskRow from '../components/TaskRow.vue';
import { useTasks } from '../composables/useTasks';

const route = useRoute();
const { tasks, unreadable, loaded, error, needsYou } = useTasks();

type Filter = 'all' | 'needs-you' | 'running' | 'finished';
const filter = ref<Filter>('all');
const search = ref('');

const groups: Record<Filter, readonly TaskStatus[]> = {
  all: ['needs-you', 'running', 'stopped', 'accepted', 'abandoned'],
  'needs-you': ['needs-you', 'stopped'],
  running: ['running'],
  finished: ['accepted', 'abandoned'],
};

const filters = computed(() => [
  { label: 'All', value: 'all' },
  { label: needsYou.value.length ? `Needs you (${needsYou.value.length})` : 'Needs you', value: 'needs-you' },
  { label: 'Running', value: 'running' },
  { label: 'Finished', value: 'finished' },
]);

/** Needs you first, then running, then the rest; newest activity first within each. */
const order: Record<TaskStatus, number> = { 'needs-you': 0, stopped: 1, running: 2, accepted: 3, abandoned: 3 };

const shown = computed(() => {
  const words = search.value.trim().toLowerCase();
  return tasks.value
    .filter(task => groups[filter.value].includes(task.status))
    .filter(
      task =>
        !words || `${task.title} ${task.repository.name} ${task.recipe} ${task.taskId}`.toLowerCase().includes(words),
    )
    .sort((a, b) => order[a.status] - order[b.status] || b.updatedAt.localeCompare(a.updatedAt));
});

const selected = computed(() => (route.name === 'task' ? String(route.params['id']) : null));
</script>

<template>
  <UDashboardPanel
    id="task-list"
    resizable
    :default-size="24"
    :min-size="18"
    :max-size="36"
    :class="{ 'max-lg:hidden': selected }"
  >
    <template #header>
      <UDashboardNavbar title="Tasks">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UBadge v-if="needsYou.length" color="warning" variant="subtle" icon="i-lucide-hand">
            {{ needsYou.length }}
          </UBadge>
        </template>
      </UDashboardNavbar>
      <div class="px-4 py-2 space-y-2 border-b border-default">
        <UTabs v-model="filter" :items="filters" :content="false" size="xs" class="w-full" />
        <UInput v-model="search" icon="i-lucide-search" placeholder="Filter tasks" size="sm" class="w-full" />
      </div>
    </template>

    <template #body>
      <div class="-mx-4 sm:-mx-6 -my-4 sm:-my-6 divide-y divide-default">
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-wifi-off" :title="error" class="m-4" />
        <template v-if="!loaded">
          <div v-for="n in 4" :key="n" class="flex gap-3 px-4 py-3">
            <USkeleton class="size-5 rounded-full" />
            <div class="flex-1 space-y-2">
              <USkeleton class="h-4 w-3/4" />
              <USkeleton class="h-3 w-1/2" />
            </div>
          </div>
        </template>
        <UEmpty
          v-else-if="!shown.length"
          icon="i-lucide-inbox"
          :title="tasks.length ? 'No tasks match' : 'No tasks yet'"
          :description="
            tasks.length ? 'Try another filter.' : 'Start one with grampus new, or from a chat with the Grampus skill.'
          "
          class="py-12"
        />
        <TaskRow v-for="task in shown" :key="task.taskId" :task="task" :selected="task.taskId === selected" />
        <div v-if="unreadable.length" class="flex gap-1.5 px-4 py-3 text-xs text-muted">
          <UIcon name="i-lucide-file-warning" class="size-3.5 shrink-0" />
          {{ unreadable.length }} task folder{{ unreadable.length === 1 ? '' : 's' }} could not be read:
          {{ unreadable.map(item => item.taskId).join(', ') }}
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <RouterView />
</template>
