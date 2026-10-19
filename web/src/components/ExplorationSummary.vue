<script setup lang="ts">
/**
 * ExplorationSummary: how much an agent searched and read the repository, the files it read recently,
 * and the MCP connections its session sees. Read access is independent of approved file changes.
 *
 * Props:
 * - `exploration`: `{ calls, readFiles }`.
 * - `integrations`: connected MCP servers with tool counts.
 */
import type { McpServerV1 } from '../../../src/server/api-types';
import { plural } from './format';

defineOptions({ name: 'ExplorationSummary' });

defineProps<{ exploration: { calls: number; readFiles: readonly string[] }; integrations: readonly McpServerV1[] }>();
</script>

<template>
  <div class="flex flex-col gap-2 text-sm">
    <p v-if="exploration.calls" class="text-toned">
      {{ plural(exploration.calls, 'search, list or read call') }} completed. Reading files does not establish test
      coverage.
    </p>
    <p v-else class="text-muted">No repository exploration recorded.</p>
    <template v-if="exploration.readFiles.length">
      <p class="text-xs text-muted">Recently read files</p>
      <pre class="grampus-code">{{ exploration.readFiles.join('\n') }}</pre>
    </template>
    <template v-if="integrations.length">
      <p class="text-xs text-muted">MCP connections</p>
      <ul class="flex flex-col gap-0.5">
        <li v-for="server in integrations" :key="server.name">
          <span class="font-medium">{{ server.name }}</span>
          <span v-if="server.tools !== null" class="text-muted"> · {{ plural(server.tools, 'tool') }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>
