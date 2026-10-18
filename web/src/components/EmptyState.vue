<script setup lang="ts">
/**
 * EmptyState: what to show where a list or panel has nothing yet, and what to do next.
 *
 * Props:
 * - `title`: short statement, e.g. "No tasks yet".
 * - `description`: optional next step, e.g. "Choose New task to plan your first change."
 * - `icon`: Lucide icon name, default `i-lucide-inbox`. Decorative only.
 *
 * Slots:
 * - `actions`: buttons for the next step.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';

defineOptions({ name: 'EmptyState' });

withDefaults(defineProps<{ title: string; description?: string; icon?: string }>(), {
  description: '',
  icon: 'i-lucide-inbox',
});

const slots = defineSlots<{ actions?: () => unknown }>();
</script>

<template>
  <div class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-accented px-6 py-10 text-center">
    <UIcon :name="icon" class="size-8 text-dimmed" aria-hidden="true" />
    <p class="font-medium text-highlighted">{{ title }}</p>
    <p v-if="description" class="max-w-md text-sm text-muted">{{ description }}</p>
    <div v-if="slots.actions" class="mt-2 flex flex-wrap justify-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
