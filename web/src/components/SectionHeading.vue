<script setup lang="ts">
/** Owns the shared icon and heading treatment for dashboard sections. */
import UIcon from '@nuxt/ui/components/Icon.vue';
defineProps<{ title: string; icon: string }>();
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div class="mb-4 flex items-center gap-3">
    <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <UIcon :name="icon" class="size-5" aria-hidden="true" />
    </span>
    <h2 class="text-base font-semibold text-highlighted">{{ title }}</h2>
    <slot />
  </div>
</template>
