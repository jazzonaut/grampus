<!-- An icon in the colour of its meaning, spinning while something is in progress. -->
<script setup lang="ts">
import type { Look } from '../presentation';

defineProps<{ look: Look; size?: string }>();

const text: Record<Look['color'], string> = {
  primary: 'text-primary',
  secondary: 'text-secondary',
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-muted',
};
</script>

<template>
  <UIcon
    :name="look.icon"
    :class="[text[look.color], size ?? 'size-5', look.spin ? 'animate-spin' : '']"
    :aria-label="look.label"
  />
</template>
