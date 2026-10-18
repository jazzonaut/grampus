<script setup lang="ts">
/**
 * StatusBadge: a status as icon, text and colour together, never colour alone.
 *
 * Props:
 * - `status`: one of the dashboard statuses (see `statuses` in theme/status.ts).
 * - `label`: optional text replacing the default label, e.g. "Needs your answer". The icon and
 *   colour still come from the status.
 * - `size`: Nuxt UI badge size, default `md`.
 */
import { computed } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { statusPresentation } from '../theme/status';
import type { Status } from '../theme/status';

defineOptions({ name: 'StatusBadge' });

const props = withDefaults(defineProps<{ status: Status; label?: string; size?: 'sm' | 'md' | 'lg' }>(), {
  size: 'md',
});

const look = computed(() => statusPresentation[props.status]);
// Work in progress spins, unless the user prefers reduced motion.
const ui = computed(() => (props.status === 'working' ? { leadingIcon: 'motion-safe:animate-spin' } : {}));
</script>

<template>
  <UBadge
    :color="look.color"
    :icon="look.icon"
    :label="label ?? look.label"
    :size="size"
    :ui="ui"
    variant="subtle"
    :data-status="status"
  />
</template>
