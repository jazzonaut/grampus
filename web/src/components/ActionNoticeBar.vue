<script setup lang="ts">
/**
 * ActionNoticeBar: what happened to the last action on this screen: requested and waiting for the server,
 * accepted but not yet reflected, refused because the page was stale, waiting for a free runner slot, or
 * failed with the server's reason.
 *
 * Props:
 * - `notice`: from `useActions().notice`.
 *
 * Emits `dismiss`.
 */
import UButton from '@nuxt/ui/components/Button.vue';
import type { ActionNotice } from '../api/useActions';
import NoticeBox from './NoticeBox.vue';

defineOptions({ name: 'ActionNoticeBar' });

defineProps<{ notice: ActionNotice | null }>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div class="empty:hidden">
    <NoticeBox v-if="notice?.kind === 'requested'" tone="info" live="status" data-notice="requested">{{
      notice.message
    }}</NoticeBox>
    <NoticeBox v-else-if="notice?.kind === 'waiting'" tone="info" live="status" data-notice="waiting">
      {{ notice.message }}
      <template #actions
        ><UButton label="Dismiss" size="sm" color="neutral" variant="ghost" @click="emit('dismiss')"
      /></template>
    </NoticeBox>
    <NoticeBox
      v-else-if="notice?.kind === 'stale'"
      tone="warning"
      title="The page was out of date"
      live="status"
      data-notice="stale"
    >
      {{ notice.message }}
      <template #actions
        ><UButton label="Dismiss" size="sm" color="neutral" variant="ghost" @click="emit('dismiss')"
      /></template>
    </NoticeBox>
    <NoticeBox
      v-else-if="notice?.kind === 'pool'"
      tone="info"
      title="Waiting for a free runner slot"
      live="status"
      data-notice="pool"
    >
      {{ notice.message }}
      <template #actions
        ><UButton label="Dismiss" size="sm" color="neutral" variant="ghost" @click="emit('dismiss')"
      /></template>
    </NoticeBox>
    <NoticeBox
      v-else-if="notice?.kind === 'error'"
      tone="error"
      title="Grampus refused this action"
      live="alert"
      data-notice="error"
    >
      <p class="whitespace-pre-line">{{ notice.message }}</p>
      <ul v-if="notice.issues.length" class="mt-1 list-disc pl-5">
        <li v-for="issue in notice.issues" :key="issue">{{ issue }}</li>
      </ul>
      <template #actions
        ><UButton label="Dismiss" size="sm" color="neutral" variant="ghost" @click="emit('dismiss')"
      /></template>
    </NoticeBox>
  </div>
</template>
