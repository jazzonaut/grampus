<!--
  What the task waits for, pinned above the tabs: the decision with the evidence behind it, and any open
  worker questions. The actions themselves are in the default slot.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { TaskDetail } from '../../../src/dashboard/types';

const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ show: [tab: string] }>();

const heading = computed(() => {
  const reason = props.task.needsYou?.reason ?? '';
  const [kind, value] = reason.split(':');
  switch (kind) {
    case 'approve-spec':
      return { icon: 'i-lucide-stamp', text: `Approve spec v${value}` };
    case 'ready':
      return { icon: 'i-lucide-circle-check', text: `Round ${value} passed everything` };
    case 'escalate':
      return { icon: 'i-lucide-hand', text: `Round ${value} needs your judgement` };
    default:
      return { icon: 'i-lucide-hand', text: 'Needs your decision' };
  }
});
const questions = computed(() => props.task.summary.questions.length);
</script>

<template>
  <div
    v-if="task.needsYou || questions"
    class="rounded-xl border border-warning/50 bg-warning/5 p-4 space-y-3"
    role="region"
    aria-label="Needs you"
  >
    <template v-if="task.needsYou">
      <div class="flex items-start gap-3">
        <UIcon :name="heading.icon" class="size-5 text-warning shrink-0 mt-0.5" />
        <div class="min-w-0 space-y-1">
          <h3 class="font-semibold text-highlighted">{{ heading.text }}</h3>
          <p class="text-sm text-muted whitespace-pre-line">{{ task.needsYou.detail }}</p>
        </div>
      </div>

      <div v-if="task.summary.approval" class="pl-8 space-y-1">
        <ul class="text-sm space-y-0.5">
          <li v-for="line in task.summary.approval.review" :key="line" class="text-muted">{{ line }}</li>
        </ul>
        <UButton size="sm" variant="link" icon="i-lucide-file-text" class="px-0" @click="emit('show', 'spec')">
          Read spec v{{ task.summary.approval.version }} before deciding
        </UButton>
      </div>

      <div v-if="task.summary.result" class="pl-8 space-y-1">
        <ul class="text-sm space-y-0.5">
          <li v-for="line in task.summary.result.lines" :key="line" class="text-muted break-words">{{ line }}</li>
        </ul>
        <UButton size="sm" variant="link" icon="i-lucide-list-checks" class="px-0" @click="emit('show', 'rounds')">
          See the evidence
        </UButton>
      </div>
    </template>

    <button
      v-if="questions"
      type="button"
      class="flex items-center gap-2 text-sm font-medium text-warning hover:underline"
      @click="emit('show', 'messages')"
    >
      <UIcon name="i-lucide-message-circle-question" class="size-5" />
      {{ questions === 1 ? 'A worker is asking you a question' : `${questions} worker questions are waiting` }}
    </button>

    <slot />
  </div>
</template>
