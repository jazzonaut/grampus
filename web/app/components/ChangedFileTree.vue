<!-- Shared folder navigation keeps every changed file accessible without an explanation. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { ChangesView } from '../../../src/dashboard/types';

const props = withDefaults(
  defineProps<{
    files: ChangesView['files'];
    prefix?: string;
    selected?: string | null;
    interactive?: boolean;
  }>(),
  { prefix: '', selected: null, interactive: false },
);
const emit = defineEmits<{ select: [path: string] }>();
const entries = computed(() => {
  const folders = new Map<string, ChangesView['files']>();
  const leaves: ChangesView['files'] = [];
  for (const file of props.files) {
    const rest = file.path.slice(props.prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) leaves.push(file);
    else {
      const folder = rest.slice(0, slash);
      const children = folders.get(folder) ?? [];
      children.push(file);
      folders.set(folder, children);
    }
  }
  return {
    folders: [...folders].sort(([a], [b]) => a.localeCompare(b)),
    leaves: leaves.sort((a, b) => a.path.localeCompare(b.path)),
  };
});
</script>

<template>
  <ul class="text-xs min-w-0">
    <li v-for="[folder, children] in entries.folders" :key="folder">
      <details open class="folder">
        <summary
          class="flex items-center gap-1 cursor-pointer px-2 py-1.5 rounded hover:bg-elevated list-none [&::-webkit-details-marker]:hidden"
        >
          <UIcon name="i-lucide-chevron-right" class="folder-chevron size-3 shrink-0 text-muted" />
          <UIcon name="i-lucide-folder" class="size-3.5 shrink-0 text-muted" />
          <span class="min-w-0 break-all">{{ folder }}</span>
          <span class="text-dimmed">{{ children.length }}</span>
        </summary>
        <ChangedFileTree
          :files="children"
          :prefix="`${prefix}${folder}/`"
          :selected="selected"
          :interactive="interactive"
          class="ml-3 border-l border-default pl-1"
          @select="emit('select', $event)"
        />
      </details>
    </li>
    <li v-for="file in entries.leaves" :key="file.path">
      <component
        :is="interactive ? 'button' : 'div'"
        :type="interactive ? 'button' : undefined"
        class="w-full flex items-start gap-1.5 text-left rounded px-2 py-1.5"
        :class="[
          interactive ? 'hover:bg-elevated focus-visible:outline-primary' : '',
          selected === file.path ? 'bg-primary/10 font-semibold' : '',
        ]"
        :aria-current="selected === file.path ? 'true' : undefined"
        :title="file.oldPath ? `${file.path} (renamed from ${file.oldPath})` : file.path"
        @click="interactive && emit('select', file.path)"
      >
        <UIcon name="i-lucide-file" class="size-3.5 shrink-0 text-muted mt-0.5" />
        <span class="min-w-0 break-all flex-1">{{ file.path.slice(prefix.length) }}</span>
        <span class="font-mono shrink-0 text-dimmed">
          <template v-if="file.added === null">binary</template>
          <template v-else
            ><span class="text-success">+{{ file.added }}</span>
            <span class="text-error">-{{ file.deleted }}</span></template
          >
        </span>
      </component>
    </li>
  </ul>
</template>

<style scoped>
.folder[open] > summary > .folder-chevron {
  transform: rotate(90deg);
}
</style>
