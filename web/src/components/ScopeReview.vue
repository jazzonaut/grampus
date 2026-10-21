<script setup lang="ts">
/**
 * ScopeReview: what file authorization grants, to inspect before deciding: each file with its action
 * (edit, create, delete) and exact current content, the repository instructions the agent will follow,
 * and why authorization cannot be prepared, when it cannot. Contents are shown literally.
 *
 * Props:
 * - `scope`: `DetailsV1.scope`.
 */
import type { ScopeView } from '../../../src/server/api-types';

defineOptions({ name: 'ScopeReview' });

defineProps<{ scope: ScopeView }>();

const actions = { edit: 'Edit', create: 'Create', delete: 'Delete' } as const;
</script>

<template>
  <div class="flex flex-col gap-2" data-panel="scope">
    <p v-if="scope.error" role="alert" class="text-sm text-error">
      File authorization could not be prepared: {{ scope.error }}
    </p>
    <p v-if="!scope.files.length && !scope.directories.length" class="text-sm text-muted">
      This slice changes no files.
    </p>
    <div v-if="scope.directories.length">
      <p class="text-sm text-muted">The agent may choose files within these approved directory grants.</p>
      <pre class="grampus-code">{{ JSON.stringify(scope.directories, null, 2) }}</pre>
    </div>
    <details
      v-for="file in scope.files"
      :key="file.path"
      class="rounded-md border border-default"
      :data-scope-file="file.path"
    >
      <summary class="cursor-pointer px-3 py-1.5 select-none hover:bg-muted">
        <span class="text-xs font-semibold tracking-wide uppercase">{{ actions[file.action] }}</span>
        <span class="ml-2 font-mono text-xs">{{ file.path }}</span>
      </summary>
      <pre class="grampus-code m-2 max-h-96" tabindex="0" :aria-label="`Current content of ${file.path}`">{{
        file.content ?? '(the file does not exist yet)'
      }}</pre>
    </details>
    <details v-if="scope.instructions.length" class="rounded-md border border-default">
      <summary class="cursor-pointer px-3 py-1.5 text-sm select-none hover:bg-muted">
        Repository instructions ({{ scope.instructions.length }})
      </summary>
      <div v-for="item in scope.instructions" :key="item.path" class="m-2">
        <p class="font-mono text-xs text-muted">{{ item.path }}</p>
        <pre class="grampus-code max-h-64" tabindex="0">{{ item.content }}</pre>
      </div>
    </details>
  </div>
</template>
