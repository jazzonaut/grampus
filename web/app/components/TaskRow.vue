<!-- One task in the list: status, title, where it runs and what it is doing now. -->
<script setup lang="ts">
import type { TaskListItem } from '../../../src/dashboard/types';
import { useNow } from '../composables/useNow';
import { ago, statusLook } from '../presentation';
import StatusIcon from './StatusIcon.vue';

defineProps<{ task: TaskListItem; selected: boolean }>();
const now = useNow();
</script>

<template>
  <RouterLink
    :to="`/tasks/${task.taskId}`"
    class="flex gap-3 px-4 py-3 border-l-2 transition-colors"
    :class="selected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-elevated/50'"
  >
    <StatusIcon :look="statusLook[task.status]" class="mt-0.5 shrink-0" />
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-2">
        <p class="font-medium truncate" :class="task.status === 'needs-you' ? 'text-highlighted' : 'text-default'">
          {{ task.title }}
        </p>
        <time class="text-xs text-dimmed shrink-0" :datetime="task.updatedAt">{{ ago(task.updatedAt, now) }}</time>
      </div>
      <p class="flex items-center gap-1 text-xs text-muted min-w-0">
        <UIcon name="i-lucide-folder-git-2" class="size-3 shrink-0" />
        <span class="truncate">{{ task.repository.name }}</span>
        <UIcon name="i-lucide-chef-hat" class="size-3 shrink-0 ml-1.5" />
        <span class="truncate">{{ task.recipe }}</span>
      </p>
      <p v-if="task.needsYou" class="mt-1 text-sm text-warning line-clamp-2">{{ task.needsYou.detail }}</p>
      <p v-else-if="task.openQuestions" class="mt-1 text-sm text-warning">
        {{ task.openQuestions === 1 ? 'A worker asks you a question' : `${task.openQuestions} questions from workers` }}
      </p>
      <p v-else class="mt-1 text-sm text-muted truncate">{{ task.phase }}</p>
    </div>
  </RouterLink>
</template>
