<script setup lang="ts">
/**
 * ChangesPanel: the files changed in the retained snapshot. Choosing one fetches its exact before and
 * after content (`ChangeV1`); contents are shown literally, never rendered.
 *
 * Props:
 * - `paths`: `DetailsV1.changes`.
 * - `changesPath`: `DetailsV1.changesPath`.
 */
import { ref } from 'vue';
import type { ChangeV1 } from '../../../src/server/api-types';
import { ApiError, get } from '../api/client';

defineOptions({ name: 'ChangesPanel' });

const props = defineProps<{ paths: readonly string[]; changesPath: string }>();

const open = ref<ChangeV1 | null>(null);
const loading = ref<string | null>(null);
const error = ref('');

async function show(path: string): Promise<void> {
  loading.value = path;
  error.value = '';
  try {
    open.value = await get<ChangeV1>(`${props.changesPath}?path=${encodeURIComponent(path)}`);
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = null;
  }
}

function side(content: string | null, encoding: string): string {
  return content ?? `(no text content: ${encoding})`;
}
</script>

<template>
  <div class="flex flex-col gap-2" data-panel="changes">
    <p v-if="!paths.length" class="text-sm text-muted">No retained changes.</p>
    <ul v-else class="flex flex-wrap gap-2">
      <li v-for="path in paths" :key="path">
        <button
          type="button"
          class="rounded-md border border-default px-2 py-1 font-mono text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary aria-pressed:bg-elevated"
          :aria-pressed="open?.path === path"
          @click="show(path)"
        >
          {{ path }}<span v-if="loading === path" class="sr-only"> (loading)</span>
        </button>
      </li>
    </ul>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <div v-if="open" class="grid gap-2 lg:grid-cols-2">
      <div>
        <p class="text-xs text-muted">Before · {{ open.before.encoding }}</p>
        <pre class="grampus-code max-h-96" tabindex="0" :aria-label="`${open.path} before`">{{
          side(open.before.content, open.before.encoding)
        }}</pre>
      </div>
      <div>
        <p class="text-xs text-muted">After · {{ open.after.encoding }}</p>
        <pre class="grampus-code max-h-96" tabindex="0" :aria-label="`${open.path} after`">{{
          side(open.after.content, open.after.encoding)
        }}</pre>
      </div>
    </div>
  </div>
</template>
