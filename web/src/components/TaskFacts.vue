<script setup lang="ts">
/** Owns the execution fact strip, using only the latest task DTO. */
import type { TaskDetailV1 } from '../../../src/server/api-types';
import UsageHeadline from './UsageHeadline.vue';
defineProps<{ task: TaskDetailV1 }>();
</script>

<template>
  <div class="grampus-stat-strip">
    <div>
      <p class="text-xs text-muted">Repository</p>
      <p class="mt-1 font-semibold text-highlighted">{{ task.header.repository.name }}</p>
      <p class="mt-1 text-xs text-muted">
        {{ task.header.mode === 'automatic' ? 'Automatic workflow' : 'Supervised workflow' }}
      </p>
    </div>
    <div>
      <p class="text-xs text-muted">Current slice</p>
      <p class="mt-1 font-semibold text-highlighted">{{ task.header.slice.index }} of {{ task.header.slice.count }}</p>
      <p class="mt-1 text-xs text-muted">{{ task.header.slice.title }}</p>
    </div>
    <div>
      <p class="text-xs text-muted">Agents</p>
      <p class="mt-1 font-semibold text-highlighted">{{ task.details.plan.implementer.label }} implements</p>
      <p class="mt-1 text-xs text-muted">{{ task.details.plan.reviewer.label }} independently reviews</p>
    </div>
    <UsageHeadline :usage="task.usage.headline" />
  </div>
</template>
