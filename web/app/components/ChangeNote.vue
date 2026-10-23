<!-- Keeps task prose readable in full; sections own any higher-level disclosure. -->
<script setup lang="ts">
import MarkdownView from './MarkdownView.vue';

defineProps<{ source: string }>();
</script>

<template>
  <MarkdownView :source="source" class="min-w-0 break-words" />
</template>
