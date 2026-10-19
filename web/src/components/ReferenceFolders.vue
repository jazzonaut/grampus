<script setup lang="ts">
/**
 * ReferenceFolders: read-only folders (other repositories, plain folders) agents may search and read
 * throughout the task. "Suggest from task description" lists folders the description mentions, each with
 * a reason; a suggestion grants nothing until it is added. File changes stay confined to the task
 * workspace.
 *
 * Props:
 * - `request`: the task description to suggest from.
 *
 * `v-model` is the folder list text, one absolute path per line.
 */
import { ref, useId } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { ReferenceSuggestionsResponse } from '../../../src/server/api-types';
import { ApiError, postUnkeyed } from '../api/client';

defineOptions({ name: 'ReferenceFolders' });

const props = defineProps<{ request: string }>();
const folders = defineModel<string>({ required: true });

const id = useId();
const suggestions = ref<ReferenceSuggestionsResponse['suggestions'] | null>(null);
const loading = ref(false);
const error = ref('');

async function suggest(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    suggestions.value = (
      await postUnkeyed<ReferenceSuggestionsResponse>('/api/references/suggest', { request: props.request })
    ).suggestions;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

function add(path: string): void {
  const lines = folders.value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.includes(path)) folders.value = [...lines, path].join('\n');
}
</script>

<template>
  <div class="flex flex-col gap-2 text-sm" data-panel="references">
    <label :for="id" class="font-medium text-highlighted">Reference folders: absolute paths, one per line</label>
    <p class="text-xs text-muted">
      Agents can search and read these folders throughout the task. File changes stay confined to the approved task
      workspace. Folders named in the description are also detected when planning starts.
    </p>
    <textarea
      :id="id"
      v-model="folders"
      rows="3"
      class="grampus-input font-mono text-xs"
      placeholder="C:\ReferenceProject"
      spellcheck="false"
    />
    <UButton
      label="Suggest from task description"
      color="neutral"
      variant="outline"
      size="sm"
      class="self-start"
      :loading="loading"
      @click="suggest"
    />
    <p v-if="error" role="alert" class="text-error">{{ error }}</p>
    <p v-if="suggestions && !suggestions.length" class="text-xs text-muted" role="status">
      No folders are mentioned in the description.
    </p>
    <ul v-if="suggestions?.length" class="flex flex-col gap-1" aria-label="Suggested reference folders">
      <li v-for="item in suggestions" :key="item.path">
        <button type="button" class="grampus-link-button w-full flex-col items-start text-left" @click="add(item.path)">
          <span class="font-mono text-xs break-all">Add {{ item.path }}</span>
          <span class="text-xs font-normal text-muted">{{ item.reason }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
