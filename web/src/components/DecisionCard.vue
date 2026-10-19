<script setup lang="ts">
/**
 * DecisionCard: one decision the user is asked to make, such as approving a plan or
 * authorising files, with what it is about and the actions available.
 *
 * Props:
 * - `title`: what is being decided, e.g. "Approve plan version 3".
 * - `status`: status shown beside the title, default `awaiting_human`.
 * - `actions`: the actions on offer (`SafeAction`). Each carries the decision key of the state
 *   displayed in this card as `expected`; the server refuses an action if the task has changed since.
 * - `busy`: disables the actions while a request is in flight.
 *
 * Emits `action` with `{ actionId, expected }`.
 *
 * Slots:
 * - `default`: what the user needs to inspect before deciding (plan summary, file list).
 */
import { useId } from 'vue';
import StatusBadge from './StatusBadge.vue';
import SafeActions from './SafeActions.vue';
import type { SafeAction, Status } from './types';

defineOptions({ name: 'DecisionCard' });

const props = withDefaults(
  defineProps<{
    title: string;
    status?: Status;
    actions: readonly SafeAction[];
    busy?: boolean;
  }>(),
  { status: 'awaiting_human', busy: false },
);

const emit = defineEmits<{ action: [choice: { actionId: string; expected: string | null }] }>();

defineSlots<{ default?: () => unknown }>();

const titleId = useId();

function expectedOf(actionId: string): string | null {
  return props.actions.find(action => action.id === actionId)?.expected ?? null;
}
</script>

<template>
  <section :aria-labelledby="titleId" class="flex flex-col gap-3 rounded-lg border border-default bg-default p-4">
    <header class="flex flex-wrap items-center gap-2">
      <StatusBadge :status="status" />
      <h2 :id="titleId" class="text-base font-semibold text-highlighted">{{ title }}</h2>
    </header>
    <div class="text-sm text-default">
      <slot />
    </div>
    <SafeActions
      :actions="actions"
      :described-by="titleId"
      :busy="busy"
      @choose="actionId => emit('action', { actionId, expected: expectedOf(actionId) })"
    />
    <p class="text-xs text-muted">
      This decision applies to the state shown here. If the task changes first, Grampus refuses it and asks you to
      refresh.
    </p>
  </section>
</template>
