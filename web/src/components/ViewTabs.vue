<script setup lang="ts">
/** Owns accessible workspace tabs. Selection is local presentation state, never controller state. */
import { useId } from 'vue';
const props = defineProps<{ items: readonly { id: string; label: string }[]; label: string }>();
const selected = defineModel<string>({ required: true });
const baseId = useId();

function move(event: KeyboardEvent, index: number): void {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % props.items.length;
  else if (event.key === 'ArrowLeft') next = (index + props.items.length - 1) % props.items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = props.items.length - 1;
  else return;
  event.preventDefault();
  const item = props.items[next];
  if (!item) return;
  selected.value = item.id;
  document.getElementById(`${baseId}-tab-${item.id}`)?.focus();
}
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div class="min-w-0">
    <div role="tablist" :aria-label="label" class="mb-6 flex gap-1 overflow-x-auto border-b border-default">
      <button
        v-for="(item, index) in items"
        :id="`${baseId}-tab-${item.id}`"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="selected === item.id"
        :aria-controls="`${baseId}-panel-${selected}`"
        :tabindex="selected === item.id ? 0 : -1"
        :class="[
          'shrink-0 border-b-2 px-4 py-3 text-sm font-medium',
          selected === item.id ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-highlighted',
        ]"
        @click="selected = item.id"
        @keydown="move($event, index)"
      >
        {{ item.label }}
      </button>
    </div>
    <section
      :id="`${baseId}-panel-${selected}`"
      role="tabpanel"
      :aria-labelledby="`${baseId}-tab-${selected}`"
      tabindex="0"
      class="min-w-0 focus:outline-none"
    >
      <slot />
    </section>
  </div>
</template>
