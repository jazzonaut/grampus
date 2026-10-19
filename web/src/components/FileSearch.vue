<script setup lang="ts">
/**
 * FileSearch: searches the pinned file inventory of a repository commit (`POST /api/repositories/files`),
 * 100 paths a page, and offers each path to add as a starting file hint. Searching reads only the
 * inventory; it starts no agent turn.
 *
 * Props:
 * - `repo`: the repository folder.
 * - `base`: the pinned commit.
 *
 * Emits `add` with a path.
 */
import { ref, useId } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { FileSearchResponse } from '../../../src/server/api-types';
import { ApiError, postUnkeyed } from '../api/client';
import { fileSearchPage } from '../settings';
import { formatCount } from './format';

defineOptions({ name: 'FileSearch' });

const props = defineProps<{ repo: string; base: string }>();

const emit = defineEmits<{ add: [path: string] }>();

const id = useId();
const query = ref('');
const page = ref<FileSearchResponse | null>(null);
const loading = ref(false);
const error = ref('');

async function search(offset = 0): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    page.value = await postUnkeyed<FileSearchResponse>('/api/repositories/files', {
      repo: props.repo,
      base: props.base,
      query: query.value,
      offset,
    });
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-md border border-default p-3" data-panel="file-search">
    <form class="flex flex-wrap items-end gap-2" role="search" @submit.prevent="search(0)">
      <div class="flex min-w-48 flex-1 flex-col gap-1">
        <label :for="id" class="text-sm font-medium text-highlighted"
          >Search the pinned file inventory: path contains</label
        >
        <input :id="id" v-model="query" class="grampus-input" placeholder="e.g. src greeting" />
      </div>
      <UButton type="submit" label="Search files" color="neutral" variant="outline" :loading="loading" />
    </form>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <template v-if="page">
      <p class="text-xs text-muted" aria-live="polite">
        {{ formatCount(page.matches) }} matches<template v-if="page.files.length">
          · showing {{ formatCount(page.offset + 1) }} to {{ formatCount(page.offset + page.files.length) }}</template
        >
      </p>
      <ul class="flex max-h-64 flex-col gap-1 overflow-auto">
        <li v-for="file in page.files" :key="file.path">
          <button
            type="button"
            class="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            @click="emit('add', file.path)"
          >
            <span class="font-mono text-xs break-all">Add {{ file.path }}</span>
            <span class="shrink-0 text-xs text-muted">{{ formatCount(file.bytes) }} bytes</span>
          </button>
        </li>
      </ul>
      <div class="flex gap-2">
        <UButton
          v-if="page.offset > 0"
          :label="`Previous ${fileSearchPage}`"
          size="sm"
          color="neutral"
          variant="ghost"
          @click="search(Math.max(0, page.offset - fileSearchPage))"
        />
        <UButton
          v-if="page.nextOffset !== null"
          :label="`Next ${fileSearchPage}`"
          size="sm"
          color="neutral"
          variant="ghost"
          @click="search(page.nextOffset)"
        />
      </div>
    </template>
  </div>
</template>
