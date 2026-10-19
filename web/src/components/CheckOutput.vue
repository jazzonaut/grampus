<script setup lang="ts">
/**
 * CheckOutput: a check's retained stdout or stderr, fetched only on request and a page at a time from
 * the server's check-output route (`CheckView.outputPath`). Control characters are removed by the server.
 *
 * Props:
 * - `outputPath`: `CheckView.outputPath`.
 * - `name`: the check name, for labels.
 * - `characters`: `{ stdout, stderr }` sizes from the view, or null when not measured.
 */
import { ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { CheckOutputPage } from '../../../src/server/api-types';
import { ApiError, get } from '../api/client';
import LogViewer from './LogViewer.vue';
import { formatCount } from './format';

defineOptions({ name: 'CheckOutput' });

const props = defineProps<{
  outputPath: string;
  name: string;
  characters: { stdout: number | null; stderr: number | null };
}>();

type Stream = 'stdout' | 'stderr';

const stream = ref<Stream | null>(null);
const text = ref('');
const nextOffset = ref<number | null>(null);
const total = ref(0);
const incomplete = ref(false);
const loading = ref(false);
const error = ref('');

async function load(chosen: Stream, offset: number): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const page = await get<CheckOutputPage>(`${props.outputPath}&stream=${chosen}&offset=${offset}`);
    text.value = offset === 0 ? page.content : text.value + page.content;
    stream.value = chosen;
    nextOffset.value = page.nextOffset;
    total.value = page.totalCharacters;
    incomplete.value = page.incomplete;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

function sizeOf(chosen: Stream): string {
  const size = props.characters[chosen];
  return size === null ? '' : ` (${formatCount(size)} characters in the journal preview)`;
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-2">
      <UButton
        v-for="choice in ['stderr', 'stdout'] as const"
        :key="choice"
        :label="`Read ${choice}`"
        size="sm"
        color="neutral"
        :variant="stream === choice ? 'solid' : 'outline'"
        :aria-pressed="stream === choice"
        :title="`Load ${choice}${sizeOf(choice)}`"
        :loading="loading && stream !== choice"
        @click="load(choice, 0)"
      />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <template v-if="stream">
      <p class="text-xs text-muted" aria-live="polite">
        {{ stream }} · characters 1 to {{ formatCount(text.length) }} of {{ formatCount(total) }}
        <template v-if="incomplete"> · only the journal's bounded preview was retained</template>
      </p>
      <LogViewer
        :label="`${stream} of ${name}`"
        :text="text"
        :has-more="nextOffset !== null"
        :loading="loading"
        empty-text="(empty)"
        @load-more="nextOffset !== null && stream && load(stream, nextOffset)"
      />
    </template>
  </div>
</template>
