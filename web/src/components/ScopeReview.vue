<script setup lang="ts">
/**
 * ScopeReview: native workspace execution confirmation, with optional file suggestions,
 * repository instructions and any reason confirmation cannot be prepared. File suggestions
 * do not restrict execution. Contents are shown literally.
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
      Workspace confirmation could not be prepared: {{ scope.error }}
    </p>
    <p class="text-sm text-muted">
      The agent chooses project files and local commands using native tools. File and folder suggestions do not limit
      execution.
    </p>
    <div v-if="scope.directories.length">
      <p class="text-sm text-muted">Suggested folders</p>
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
