<script setup lang="ts">
/**
 * NoticeBox: a short inline message with an icon and a tone, for explanations, stale-page notices,
 * stall warnings and refusals. The tone is never the only signal: the icon and the text carry it too.
 *
 * Props:
 * - `tone`: `info` (default), `warning`, `error` or `success`.
 * - `title`: optional bold first line.
 * - `live`: announce changes politely (`status`) or at once (`alert`); default none.
 *
 * Slots:
 * - `default`: the message.
 * - `actions`: optional buttons under the message.
 */
import { computed } from 'vue';
import UIcon from '@nuxt/ui/components/Icon.vue';

defineOptions({ name: 'NoticeBox' });

const props = withDefaults(
  defineProps<{ tone?: 'info' | 'warning' | 'error' | 'success'; title?: string; live?: 'status' | 'alert' }>(),
  { tone: 'info' },
);

const slots = defineSlots<{ default?: () => unknown; actions?: () => unknown }>();

const looks = {
  info: { icon: 'i-lucide-info', box: 'border-info/40 bg-info/10', text: 'text-info' },
  warning: { icon: 'i-lucide-triangle-alert', box: 'border-warning/40 bg-warning/10', text: 'text-warning' },
  error: { icon: 'i-lucide-circle-x', box: 'border-error/40 bg-error/10', text: 'text-error' },
  success: { icon: 'i-lucide-circle-check', box: 'border-success/40 bg-success/10', text: 'text-success' },
} as const;

const look = computed(() => looks[props.tone]);
</script>

<template>
  <div :role="live" :class="['flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', look.box]" :data-tone="tone">
    <UIcon :name="look.icon" :class="['mt-0.5 size-4 shrink-0', look.text]" aria-hidden="true" />
    <div class="min-w-0 flex-1 break-words">
      <p v-if="title" class="font-semibold text-highlighted">{{ title }}</p>
      <div class="text-default"><slot /></div>
      <div v-if="slots.actions" class="mt-2 flex flex-wrap gap-2"><slot name="actions" /></div>
    </div>
  </div>
</template>
