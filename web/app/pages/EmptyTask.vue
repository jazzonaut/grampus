<!-- Shown beside the list on wide screens when no task is selected. -->
<script setup lang="ts">
import { useTasks } from '../composables/useTasks';

const { needsYou } = useTasks();
</script>

<template>
  <UDashboardPanel id="task-empty" class="max-lg:hidden">
    <template #body>
      <UEmpty
        icon="i-lucide-mouse-pointer-click"
        title="Select a task"
        :description="
          needsYou.length
            ? `${needsYou.length} task${needsYou.length === 1 ? '' : 's'} need${needsYou.length === 1 ? 's' : ''} a decision from you.`
            : 'Its pipeline, evidence and measurements show here.'
        "
        class="h-full"
      />
    </template>
  </UDashboardPanel>
</template>
