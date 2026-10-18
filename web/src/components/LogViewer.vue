<script setup lang="ts">
/**
 * LogViewer: command output in a bounded, scrollable monospace block, loaded a page at a time.
 *
 * The server returns check logs in pages (about 16,000 characters each). The parent keeps the
 * pages loaded so far and passes their text; this component shows it and offers "Load more"
 * while the server has more.
 *
 * Props:
 * - `label`: accessible name of the log, e.g. "stderr of npm test". Required: the block is a
 *   focusable region so keyboard users can scroll it.
 * - `text`: the text of the pages loaded so far.
 * - `hasMore`: the server has more pages.
 * - `loading`: a page request is in flight.
 * - `emptyText`: shown when there is no output, default "No output".
 *
 * Emits `loadMore` when the user asks for the next page.
 */
import UButton from '@nuxt/ui/components/Button.vue';

defineOptions({ name: 'LogViewer' });

withDefaults(defineProps<{ label: string; text: string; hasMore?: boolean; loading?: boolean; emptyText?: string }>(), {
  hasMore: false,
  loading: false,
  emptyText: 'No output',
});

const emit = defineEmits<{ loadMore: [] }>();
</script>

<template>
  <div class="flex flex-col gap-2">
    <pre
      role="region"
      :aria-label="label"
      tabindex="0"
      class="max-h-96 overflow-auto rounded-md border border-default bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-default"
      >{{ text === '' ? emptyText : text }}</pre>
    <div v-if="hasMore" class="flex items-center gap-2">
      <UButton
        label="Load more"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-chevrons-down"
        :loading="loading"
        :aria-label="`Load more of ${label}`"
        @click="emit('loadMore')"
      />
      <span class="text-xs text-muted">Showing the output loaded so far.</span>
    </div>
  </div>
</template>
