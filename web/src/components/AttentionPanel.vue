<script setup lang="ts">
/**
 * AttentionPanel: everything waiting for a person across tasks and planning conversations (the
 * overview's attention queue, most urgent first), with the reason and the safe actions that resolve it.
 * Actions that need a form (answers, an assessment) link to their screen; the rest are buttons here.
 *
 * Props:
 * - `items`: `AttentionItem`s from the overview.
 * - `busy`: an action is in flight or waits for the server; buttons are disabled.
 * - `sending`: `{ itemId, actionId }` of the action being sent.
 *
 * Emits `run` with the item and the `ActionView` chosen.
 */
import { useId } from 'vue';
import type { ActionView, AttentionItem } from '../../../src/server/api-types';
import { href } from '../router';
import ActionButton from './ActionButton.vue';
import StatusBadge from './StatusBadge.vue';

defineOptions({ name: 'AttentionPanel' });

withDefaults(
  defineProps<{
    items: readonly AttentionItem[];
    busy?: boolean;
    sending?: { itemId: string; actionId: string } | null;
  }>(),
  { busy: false, sending: null },
);

const emit = defineEmits<{ run: [item: AttentionItem, action: ActionView] }>();

const baseId = useId();

function link(item: AttentionItem): string {
  return item.taskId ? href({ name: 'task', id: item.taskId }) : href({ name: 'planning', id: item.kickoffId ?? '' });
}
</script>

<template>
  <section
    :aria-labelledby="`${baseId}-heading`"
    class="rounded-lg border-2 border-warning/50 bg-warning/5"
    data-panel="attention"
  >
    <h2
      :id="`${baseId}-heading`"
      class="flex items-center gap-2 px-4 pt-3 pb-2 text-base font-semibold text-highlighted"
    >
      Needs your attention
      <span class="text-sm font-normal text-muted">({{ items.length }})</span>
    </h2>
    <ul v-if="items.length" class="divide-y divide-default border-t border-default">
      <li v-for="item in items" :key="item.id" class="flex flex-col gap-2 px-4 py-3" :data-attention="item.kind">
        <div class="flex flex-wrap items-center gap-2">
          <StatusBadge :status="item.status" size="sm" />
          <h3 :id="`${baseId}-${item.id}`" class="font-medium text-highlighted">
            <a :href="link(item)" class="underline-offset-2 hover:underline">{{ item.title }}</a>
          </h3>
          <span v-if="item.stopReason" class="font-mono text-xs text-muted">{{ item.stopReason }}</span>
        </div>
        <p class="text-sm text-toned">{{ item.why }}</p>
        <div v-if="item.actions.length" class="flex flex-wrap items-start gap-2">
          <template v-for="action in item.actions" :key="action.id">
            <a
              v-if="action.form"
              :href="link(item)"
              class="inline-flex items-center rounded-md border border-accented px-3 py-1.5 text-sm font-medium text-highlighted hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              Open to {{ action.label.charAt(0).toLowerCase() + action.label.slice(1) }}
            </a>
            <ActionButton
              v-else-if="action.request.method === 'POST'"
              :action="action"
              :busy="busy"
              :sending="sending?.itemId === item.id && sending.actionId === action.id"
              :described-by="`${baseId}-${item.id}`"
              @run="emit('run', item, action)"
            />
          </template>
        </div>
      </li>
    </ul>
    <p v-else class="border-t border-default px-4 py-3 text-sm text-muted">Nothing needs you right now.</p>
  </section>
</template>
