<script setup lang="ts">
/**
 * CommandDetails: the exact command a check or preparation step runs, collapsed by default: the
 * executable, each argument on its own and the argument array as JSON. Nothing is shell-quoted or
 * rendered as Markdown, so what is shown is what runs.
 *
 * Props:
 * - `command`: `{ file, args }`.
 * - `summary`: the toggle text, default "Exact command".
 */
withDefaults(
  defineProps<{
    command: {
      file: string;
      args: readonly string[];
      restore?: { inputs: string[]; outputs: string[] };
      reuse?: { inputs: string[] };
    };
    summary?: string;
  }>(),
  {
    summary: 'Exact command',
  },
);

defineOptions({ name: 'CommandDetails' });
</script>

<template>
  <details class="rounded-md border border-default text-sm">
    <summary class="cursor-pointer px-3 py-1.5 text-toned select-none hover:bg-muted">{{ summary }}</summary>
    <div class="flex flex-col gap-1 border-t border-default px-3 py-2">
      <p class="text-xs text-muted">Executable</p>
      <pre class="grampus-code">{{ command.file }}</pre>
      <p class="text-xs text-muted">Arguments (JSON array, preserving exact boundaries)</p>
      <pre class="grampus-code">{{ JSON.stringify(command.args, null, 2) }}</pre>
      <template v-if="command.restore">
        <p class="text-xs text-muted">Restore reuse: all declared inputs and managed outputs must match</p>
        <pre class="grampus-code">{{ JSON.stringify(command.restore, null, 2) }}</pre>
      </template>
      <template v-if="command.reuse">
        <p class="text-xs text-muted">May reuse only with matching artifact and declared local inputs</p>
        <pre class="grampus-code">{{ JSON.stringify(command.reuse, null, 2) }}</pre>
      </template>
    </div>
  </details>
</template>
