<script setup lang="ts">
/**
 * SafeActions: a row of labelled action buttons for one decision. Used by AttentionPanel and
 * DecisionCard so every decision button looks and behaves the same.
 *
 * Props:
 * - `actions`: the actions to offer (`SafeAction`, the button part of the server's `ActionView`: id,
 *   label, kind, expected decision key, disabledReason).
 * - `describedBy`: id of the element naming what the actions apply to, so "Approve" is read
 *   out with its context.
 * - `busy`: disables every action while a request is in flight, so nothing is sent twice.
 *
 * Emits `choose(actionId)`.
 */
import UButton from '@nuxt/ui/components/Button.vue';
import type { ActionTone, SafeAction } from './types';

defineOptions({ name: 'SafeActions' });

withDefaults(defineProps<{ actions: readonly SafeAction[]; describedBy?: string; busy?: boolean }>(), {
  busy: false,
});

const emit = defineEmits<{ choose: [actionId: string] }>();

const look: Readonly<
  Record<ActionTone, { color: 'primary' | 'neutral' | 'error'; variant: 'solid' | 'outline' | 'soft' }>
> = {
  primary: { color: 'primary', variant: 'solid' },
  secondary: { color: 'neutral', variant: 'outline' },
  danger: { color: 'error', variant: 'soft' },
};
</script>

<template>
  <div class="flex flex-wrap items-start gap-2">
    <div v-for="action in actions" :key="action.id" class="flex flex-col gap-1">
      <UButton
        :label="action.label"
        :color="look[action.kind].color"
        :variant="look[action.kind].variant"
        :disabled="busy || action.disabledReason !== null"
        :aria-describedby="describedBy"
        @click="emit('choose', action.id)"
      />
      <span v-if="action.disabledReason" class="max-w-56 text-xs text-muted">{{ action.disabledReason }}</span>
    </div>
  </div>
</template>
