<script setup lang="ts">
/**
 * DiscussionThread: a planning conversation's messages, oldest first, with author and time. Text is
 * sanitised Markdown; answers arrive one per line and a plan reply is described rather than dumped as
 * JSON (both by the server). Before the first message the original request is shown.
 *
 * Props:
 * - `messages`: `KickoffDetailV1.messages`.
 * - `request`: the original request.
 */
import { useId } from 'vue';
import type { KickoffMessageV1 } from '../../../src/server/api-types';
import MarkdownView from './MarkdownView.vue';
import { localTime } from './format';

defineOptions({ name: 'DiscussionThread' });

defineProps<{ messages: readonly KickoffMessageV1[]; request: string }>();

const headingId = useId();
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-3" data-panel="discussion">
    <h2 :id="headingId" class="text-base font-semibold text-highlighted">Discussion</h2>
    <ol v-if="messages.length" class="flex flex-col gap-3">
      <li
        v-for="(message, index) in messages"
        :key="index"
        :class="[
          'rounded-lg border px-4 py-3 text-sm',
          message.role === 'user' ? 'border-default bg-muted md:ml-12' : 'border-primary/30 bg-default md:mr-12',
        ]"
        :data-role="message.role"
      >
        <p class="mb-1 flex flex-wrap gap-2 text-xs text-muted">
          <span class="font-semibold text-highlighted">{{ message.author }}</span>
          <time :datetime="message.at">{{ localTime(message.at) }}</time>
          <span v-if="message.kind === 'answers'">· answers</span>
          <span v-else-if="message.kind === 'proposal'">· plan proposal</span>
        </p>
        <MarkdownView :source="message.text" />
      </li>
    </ol>
    <div v-else class="rounded-lg border border-default bg-muted px-4 py-3 text-sm">
      <p class="mb-1 text-xs font-semibold text-muted">Your request</p>
      <MarkdownView :source="request" />
    </div>
  </section>
</template>
