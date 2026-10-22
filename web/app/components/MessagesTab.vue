<!-- Worker questions and other messages, each with the answer it got and who gave it. -->
<script setup lang="ts">
import type { MessageView } from '../../../src/dashboard/types';
import { when } from '../presentation';
import MarkdownView from './MarkdownView.vue';

defineProps<{ messages: MessageView[] }>();

const sourceIcon = {
  cli: 'i-lucide-terminal',
  chat: 'i-lucide-message-circle',
  dashboard: 'i-lucide-layout-dashboard',
} as const;
</script>

<template>
  <UEmpty
    v-if="!messages.length"
    icon="i-lucide-messages-square"
    title="No questions"
    description="When a worker asks something, it appears here with your answer."
  />
  <ol v-else class="space-y-5">
    <li v-for="message in messages" :key="message.messageId" class="space-y-2">
      <div class="flex gap-2 max-w-3xl">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated">
          <UIcon name="i-lucide-bot" class="size-4 text-muted" />
        </span>
        <div
          class="min-w-0 rounded-2xl rounded-tl-sm border px-4 py-2.5"
          :class="
            message.kind === 'question' && !message.answered && !message.closed
              ? 'border-warning/60 bg-warning/5'
              : 'border-default bg-elevated/40'
          "
        >
          <p class="text-xs text-muted mb-1 flex flex-wrap items-center gap-1.5">
            <UBadge size="sm" variant="subtle" color="neutral" class="font-mono">{{
              message.stage ?? 'worker'
            }}</UBadge>
            <span v-if="message.kind !== 'question'">{{ message.kind }}</span>
            <time :datetime="message.at">{{ when(message.at) }}</time>
          </p>
          <p v-if="message.subject && message.subject !== message.body" class="text-sm font-medium">
            {{ message.subject }}
          </p>
          <MarkdownView v-if="message.body" :source="message.body" />
        </div>
      </div>
      <div v-if="message.answer" class="flex gap-2 justify-end max-w-3xl ml-auto">
        <div class="min-w-0 rounded-2xl rounded-tr-sm bg-primary/10 border border-primary/30 px-4 py-2.5">
          <p class="text-xs text-muted mb-1 flex items-center gap-1.5 justify-end">
            <UIcon :name="sourceIcon[message.answer.source]" class="size-3" /> from {{ message.answer.source }} ·
            <time :datetime="message.answer.at">{{ when(message.answer.at) }}</time>
          </p>
          <p class="text-sm whitespace-pre-line">{{ message.answer.body }}</p>
        </div>
        <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <UIcon name="i-lucide-user" class="size-4 text-primary" />
        </span>
      </div>
      <p
        v-else-if="message.kind === 'question' && message.closed"
        class="text-sm text-muted pl-10 flex items-center gap-1.5"
      >
        <UIcon name="i-lucide-circle-slash" class="size-4" /> Closed without an answer: the worker finished first
      </p>
      <slot v-else-if="message.kind === 'question'" name="reply" :message="message">
        <p class="text-sm text-warning pl-10 flex items-center gap-1.5">
          <UIcon name="i-lucide-hand" class="size-4" /> Waiting for your answer
        </p>
      </slot>
    </li>
  </ol>
</template>
