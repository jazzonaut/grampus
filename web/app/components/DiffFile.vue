<!-- One complete file diff with keyboard accessible line selection and stable candidate line anchors. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { CodeReference } from '../../../src/domain/explanation';

const props = defineProps<{
  path: string;
  patch: string;
  selected: CodeReference | null;
  highlighted: CodeReference | null;
}>();
const emit = defineEmits<{ select: [reference: CodeReference] }>();
type Line = { text: string; old: number | null; current: number | null; kind: 'add' | 'delete' | 'context' | 'meta' };
const lines = computed<Line[]>(() => {
  const result: Line[] = [];
  let old = 0;
  let current = 0;
  let inHunk = false;
  for (const text of props.patch.replace(/\r?\n$/, '').split(/\r?\n/)) {
    if (text.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      current = Number(hunk[2]);
      inHunk = true;
      result.push({ text, old: null, current: null, kind: 'meta' });
      continue;
    }
    if (!inHunk) {
      result.push({ text, old: null, current: null, kind: 'meta' });
      continue;
    }
    if (text.startsWith('+')) {
      result.push({ text, old: null, current: current++, kind: 'add' });
      continue;
    }
    if (text.startsWith('-')) {
      result.push({ text, old: old++, current: null, kind: 'delete' });
      continue;
    }
    if (text.startsWith('\\')) {
      result.push({ text, old: null, current: null, kind: 'meta' });
      continue;
    }
    result.push({ text, old: old++, current: current++, kind: 'context' });
  }
  return result;
});
function within(reference: CodeReference | null, line: number | null): boolean {
  return (
    !!reference && line !== null && reference.path === props.path && line >= reference.start && line <= reference.end
  );
}
function select(line: number | null, event: MouseEvent): void {
  if (line === null) return;
  const start = event.shiftKey && props.selected?.path === props.path ? Math.min(props.selected.start, line) : line;
  const end = event.shiftKey && props.selected?.path === props.path ? Math.max(props.selected.end, line) : line;
  emit('select', { path: props.path, start, end });
}
</script>

<template>
  <div class="overflow-x-auto" :aria-label="`Diff for ${path}`">
    <div
      v-for="(line, index) in lines"
      :id="line.current === null ? undefined : `code-${path}-${line.current}`"
      :key="index"
      class="flex min-w-max font-mono text-xs leading-5 whitespace-pre"
      :class="[
        line.kind === 'add'
          ? 'bg-success/10'
          : line.kind === 'delete'
            ? 'bg-error/10'
            : line.kind === 'meta'
              ? 'bg-elevated text-muted'
              : '',
        within(highlighted, line.current) ? 'ring-1 ring-inset ring-primary' : '',
        within(selected, line.current) ? 'bg-primary/15' : '',
      ]"
    >
      <span class="w-12 shrink-0 text-right pr-2 select-none text-dimmed">{{ line.old ?? '' }}</span>
      <button
        type="button"
        class="w-12 shrink-0 text-right pr-2 select-none text-dimmed border-r border-default"
        :disabled="line.current === null"
        :aria-label="line.current === null ? 'No candidate line' : `Select ${path} line ${line.current}`"
        @click="select(line.current, $event)"
      >
        {{ line.current ?? '' }}
      </button>
      <span class="px-3">{{ line.text || ' ' }}</span>
    </div>
  </div>
</template>
