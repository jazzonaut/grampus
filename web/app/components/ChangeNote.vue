<!-- Keeps older, verbose reports scannable without discarding their full text. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ source: string }>();
const expanded = ref(false);
const lengthy = computed(() => props.source.length > 160 || props.source.includes('\n'));
watch(
  () => props.source,
  () => {
    expanded.value = false;
  },
);
</script>

<template>
  <div class="min-w-0 break-words">
    <MarkdownView :source="source" :class="{ 'line-clamp-3': lengthy && !expanded }" />
    <button
      v-if="lengthy"
      type="button"
      class="mt-1 text-xs text-muted underline underline-offset-2 hover:text-highlighted focus-visible:outline-primary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show less' : 'Read more' }}
    </button>
  </div>
</template>
