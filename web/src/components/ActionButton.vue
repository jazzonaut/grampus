<script setup lang="ts">
/**
 * ActionButton: one server action without a form, drawn from its `ActionView`. A disabled action shows
 * why; an action with a `confirm` question asks it inline first and moves focus to the confirmation.
 *
 * Props:
 * - `action`: the `ActionView` (label, kind, description, confirm, enabled, disabledReason).
 * - `busy`: another request is in flight or waits for the server; the button is disabled.
 * - `sending`: this action is being sent; the button shows progress.
 * - `describedBy`: id of the element naming what the action applies to.
 * - `showDescription`: print the action's consequence under the button.
 *
 * Emits `run` when chosen (after confirmation, when it needs one).
 */
import { nextTick, ref, useId, useTemplateRef } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { ActionView } from '../../../src/server/api-types';

defineOptions({ name: 'ActionButton' });

const props = withDefaults(
  defineProps<{
    action: ActionView;
    busy?: boolean;
    sending?: boolean;
    describedBy?: string;
    showDescription?: boolean;
  }>(),
  { busy: false, sending: false, showDescription: false },
);

const emit = defineEmits<{ run: [] }>();

const confirming = ref(false);
const confirmId = useId();
const descriptionId = useId();
const confirmBox = useTemplateRef<HTMLElement>('confirmBox');

const look = {
  primary: { color: 'primary', variant: 'solid' },
  secondary: { color: 'neutral', variant: 'outline' },
  danger: { color: 'error', variant: 'soft' },
} as const;

async function choose(): Promise<void> {
  if (!props.action.confirm) {
    emit('run');
    return;
  }
  confirming.value = true;
  await nextTick();
  confirmBox.value?.querySelector<HTMLButtonElement>('button')?.focus();
}

function confirm(): void {
  confirming.value = false;
  emit('run');
}
</script>

<template>
  <div class="flex flex-col gap-1" :data-action="action.id">
    <UButton
      :label="action.label"
      :color="look[action.kind].color"
      :variant="look[action.kind].variant"
      :disabled="busy || !action.enabled || confirming"
      :loading="sending"
      :aria-describedby="
        [describedBy, showDescription ? descriptionId : undefined].filter(Boolean).join(' ') || undefined
      "
      class="self-start"
      @click="choose"
    />
    <p v-if="showDescription" :id="descriptionId" class="max-w-prose text-xs text-muted">{{ action.description }}</p>
    <p v-if="action.disabledReason" class="max-w-prose text-xs text-muted" data-disabled-reason>
      {{ action.disabledReason }}
    </p>
    <div
      v-if="confirming"
      ref="confirmBox"
      role="group"
      :aria-labelledby="confirmId"
      class="mt-1 flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3"
    >
      <p :id="confirmId" class="text-sm text-highlighted">{{ action.confirm }}</p>
      <div class="flex flex-wrap gap-2">
        <UButton :label="`Yes, ${action.label.toLowerCase()}`" color="error" size="sm" data-confirm @click="confirm" />
        <UButton label="Cancel" color="neutral" variant="outline" size="sm" @click="confirming = false" />
      </div>
    </div>
  </div>
</template>
