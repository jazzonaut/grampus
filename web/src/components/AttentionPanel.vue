<script setup lang="ts">
/**
 * AttentionPanel: everything that is waiting for a person, with the reason and the safe
 * actions that resolve it.
 *
 * Props:
 * - `items`: `AttentionItem`s (id, title, why, status, decisionKey, actions).
 * - `busyItemId`: the item whose action request is in flight; its buttons are disabled.
 * - `heading`: panel heading, default "Needs your attention".
 *
 * Emits `action` with `{ itemId, actionId, decisionKey }`. The decision key is the one shown
 * with the item, so the server can refuse the action if the task changed in the meantime.
 *
 * Slots:
 * - `empty`: shown when there are no items; defaults to a short "Nothing needs you" line.
 */
import { useId } from 'vue';
import StatusBadge from './StatusBadge.vue';
import SafeActions from './SafeActions.vue';
import type { ActionChoice, AttentionItem } from './types';

defineOptions({ name: 'AttentionPanel' });

withDefaults(defineProps<{ items: readonly AttentionItem[]; busyItemId?: string; heading?: string }>(), {
  heading: 'Needs your attention',
});

const emit = defineEmits<{ action: [choice: ActionChoice] }>();

defineSlots<{ empty?: () => unknown }>();

const baseId = useId();

function choose(item: AttentionItem, actionId: string): void {
  emit('action', { itemId: item.id, actionId, decisionKey: item.decisionKey });
}
</script>

<template>
  <section :aria-labelledby="`${baseId}-heading`" class="rounded-lg border border-default bg-default">
    <h2 :id="`${baseId}-heading`" class="border-b border-default px-4 py-3 text-base font-semibold text-highlighted">
      {{ heading }}
      <span v-if="items.length" class="ml-1 text-sm font-normal text-muted">({{ items.length }})</span>
    </h2>
    <ul v-if="items.length" class="divide-y divide-default">
      <li v-for="item in items" :key="item.id" class="flex flex-col gap-2 px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <StatusBadge :status="item.status" size="sm" />
          <h3 :id="`${baseId}-${item.id}`" class="font-medium text-highlighted">{{ item.title }}</h3>
        </div>
        <p class="text-sm text-toned">{{ item.why }}</p>
        <SafeActions
          :actions="item.actions"
          :described-by="`${baseId}-${item.id}`"
          :busy="busyItemId === item.id"
          @choose="actionId => choose(item, actionId)"
        />
      </li>
    </ul>
    <div v-else class="px-4 py-3 text-sm text-muted">
      <slot name="empty">Nothing needs you right now.</slot>
    </div>
  </section>
</template>
