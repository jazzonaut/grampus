<script setup lang="ts">
/**
 * StartingFileHints: optional starting files for a new planning conversation. "Suggest starting files"
 * inspects the repository (`POST /api/repositories/inspect`), pins its commit and suggests paths from the
 * description; the paths can be edited and searched in the pinned inventory. Hints grant no edit
 * permission; agents find and read the code they need themselves.
 *
 * Props:
 * - `repo`, `request`: from the new-task form.
 *
 * `v-model:preview` holds the inspection and `v-model:hints` the edited paths, one per line.
 */
import { ref, useId } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { InspectRepositoryResponse } from '../../../src/server/api-types';
import { ApiError, postUnkeyed } from '../api/client';
import FileSearch from './FileSearch.vue';
import { formatCount } from './format';

defineOptions({ name: 'StartingFileHints' });

const props = defineProps<{ repo: string; request: string }>();
const preview = defineModel<InspectRepositoryResponse | null>('preview', { required: true });
const hints = defineModel<string>('hints', { required: true });

const id = useId();
const loading = ref(false);
const error = ref('');

async function inspect(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const inspected = await postUnkeyed<InspectRepositoryResponse>('/api/repositories/inspect', {
      repo: props.repo,
      request: props.request,
    });
    // A model reads back the parent's value only after it re-renders, so use the response itself.
    preview.value = inspected;
    hints.value = inspected.context.selected.join('\n');
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

function add(path: string): void {
  const lines = hints.value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.includes(path)) hints.value = [...lines, path].join('\n');
}
</script>

<template>
  <details class="rounded-md border border-default" data-panel="file-hints">
    <summary class="cursor-pointer px-3 py-2 text-sm font-medium select-none hover:bg-muted">
      Optional file hints
    </summary>
    <div class="flex flex-col gap-3 border-t border-default p-3 text-sm">
      <p class="text-muted">
        Point the planner at useful files, or leave discovery to the agent. Hints do not grant edit permission.
      </p>
      <UButton
        :label="preview ? 'Refresh suggestions' : 'Suggest starting files'"
        color="neutral"
        variant="outline"
        size="sm"
        class="self-start"
        :loading="loading"
        :disabled="!repo.trim()"
        @click="inspect"
      />
      <p v-if="!repo.trim()" class="text-xs text-muted">Enter the repository folder first.</p>
      <p v-if="error" role="alert" class="text-error">{{ error }}</p>
      <template v-if="preview">
        <p class="text-toned">
          {{ formatCount(preview.context.totalFiles) }} files in the pinned commit
          <code class="font-mono text-xs">{{ preview.base.slice(0, 12) }}</code
          >. Agents can search and read the rest as needed.
        </p>
        <div class="flex flex-col gap-1">
          <label :for="id" class="font-medium text-highlighted">Optional starting paths, one per line</label>
          <textarea :id="id" v-model="hints" rows="6" class="grampus-input font-mono text-xs" spellcheck="false" />
        </div>
        <details>
          <summary class="cursor-pointer text-toned select-none">Repository map</summary>
          <pre class="grampus-code mt-1 max-h-64">{{
            preview.context.directories.map(item => `${item.path}: ${item.files} files`).join('\n')
          }}</pre>
          <p class="mt-1 text-xs text-muted">Inventory digest: {{ preview.context.inventoryDigest }}</p>
        </details>
        <FileSearch :repo="preview.repo" :base="preview.base" @add="add" />
      </template>
    </div>
  </details>
</template>
