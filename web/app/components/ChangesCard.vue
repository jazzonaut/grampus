<!--
  The files the task's branch changes so far, as a folder tree with lines added and deleted, and the full
  diff in a dialog. Counts are of committed work at the worktree's current commit, which is what checks
  and review see; folders with a single subfolder are joined into one row, as code hosts do.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ChangesView, DiffView } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { shortSha } from '../presentation';

const props = defineProps<{ taskId: string; updatedAt: string }>();

const changes = ref<ChangesView | null>(null);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    changes.value = await getJson<ChangesView>(`/api/tasks/${encodeURIComponent(props.taskId)}/changes`);
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  }
}
watch(() => [props.taskId, props.updatedAt], load, { immediate: true });

type File = ChangesView['files'][number];
interface Folder {
  name: string;
  folders: Map<string, Folder>;
  files: File[];
  added: number;
  deleted: number;
}
type Row =
  | { kind: 'folder'; key: string; name: string; depth: number; added: number; deleted: number; parents: string[] }
  | { kind: 'file'; key: string; name: string; depth: number; file: File; parents: string[] };

function folder(name: string): Folder {
  return { name, folders: new Map(), files: [], added: 0, deleted: 0 };
}

/** Folders hold their files and count the lines of everything beneath them. */
function tree(files: readonly File[]): Folder {
  const root = folder('');
  for (const file of files) {
    const path = [root];
    for (const part of file.path.split('/').slice(0, -1)) {
      const parent = path.at(-1) as Folder;
      const next = parent.folders.get(part) ?? folder(part);
      parent.folders.set(part, next);
      path.push(next);
    }
    for (const entry of path) {
      entry.added += file.added ?? 0;
      entry.deleted += file.deleted ?? 0;
    }
    (path.at(-1) as Folder).files.push(file);
  }
  return root;
}

function rows(folder: Folder, depth: number, parents: string[], prefix: string): Row[] {
  const result: Row[] = [];
  for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    let joined = child;
    let name = child.name;
    while (joined.files.length === 0 && joined.folders.size === 1) {
      joined = [...joined.folders.values()][0] as Folder;
      name = `${name}/${joined.name}`;
    }
    const key = `${prefix}${name}/`;
    result.push({
      kind: 'folder',
      key,
      name: `${name}/`,
      depth,
      added: joined.added,
      deleted: joined.deleted,
      parents,
    });
    result.push(...rows(joined, depth + 1, [...parents, key], key));
  }
  for (const file of [...folder.files].sort((a, b) => a.path.localeCompare(b.path)))
    result.push({ kind: 'file', key: file.path, name: file.path.split('/').at(-1) ?? file.path, depth, file, parents });
  return result;
}

const closed = ref(new Set<string>());
const root = computed(() => (changes.value ? tree(changes.value.files) : null));
const shown = computed(() =>
  root.value ? rows(root.value, 0, [], '').filter(row => !row.parents.some(key => closed.value.has(key))) : [],
);
function toggle(key: string): void {
  const next = new Set(closed.value);
  if (!next.delete(key)) next.add(key);
  closed.value = next;
}

// The full diff loads when the dialog opens, and again when the branch moves on while it is open.
const open = ref(false);
const diff = ref<DiffView | null>(null);
const diffError = ref<string | null>(null);
const target = ref<string | null>(null);
const body = ref<HTMLElement | null>(null);

async function loadDiff(): Promise<void> {
  try {
    diff.value = await getJson<DiffView>(`/api/tasks/${encodeURIComponent(props.taskId)}/diff`);
    diffError.value = null;
  } catch (failure) {
    diffError.value = (failure as Error).message;
  }
}
watch(
  () => [open.value, changes.value?.sha],
  async () => {
    if (!open.value) return;
    if (diff.value?.sha !== changes.value?.sha) await loadDiff();
    await nextTick();
    if (target.value)
      body.value
        ?.querySelector(`[data-path="${CSS.escape(target.value)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },
);
function show(path: string | null): void {
  target.value = path;
  open.value = true;
}

/**
 * The diff split into one section per file. A section is named by the first path line Git writes for it:
 * `rename to` for a rename, `--- a/` when the file existed before, `+++ b/` when it is new, so the name
 * matches the path the tree shows. Binary files have none, so their `diff --git` header names them.
 */
const sections = computed(() => {
  if (!diff.value) return [];
  const result: { path: string; named: boolean; lines: string[] }[] = [];
  for (const line of diff.value.patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const header = line.slice('diff --git '.length);
      result.push({ path: /^a\/(.+) b\/\1$/.exec(header)?.[1] ?? header, named: false, lines: [] });
      continue;
    }
    const section = result.at(-1);
    if (!section) continue;
    section.lines.push(line);
    const named = /^(?:rename to |--- a\/|\+\+\+ b\/)(.+)$/.exec(line);
    if (named?.[1] && !section.named) Object.assign(section, { path: named[1], named: true });
  }
  return result;
});

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-dimmed';
  if (line.startsWith('+')) return 'bg-success/10 text-success';
  if (line.startsWith('-')) return 'bg-error/10 text-error';
  if (line.startsWith('@@')) return 'text-info';
  return /^(index|new file|deleted file|similarity|rename|old mode|new mode|Binary) /.test(line) ? 'text-dimmed' : '';
}

const totals = computed(() => ({
  added: changes.value?.files.reduce((sum, file) => sum + (file.added ?? 0), 0) ?? 0,
  deleted: changes.value?.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0) ?? 0,
}));
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-semibold flex items-center gap-2">
          <UIcon name="i-lucide-file-diff" class="size-4" /> Files changed
          <UBadge v-if="changes?.files.length" size="sm" variant="subtle" color="neutral">
            {{ changes.files.length }}
          </UBadge>
        </h3>
        <span v-if="changes?.files.length" class="font-mono text-xs">
          <span class="text-success">+{{ totals.added }}</span>
          <span class="text-error ml-1.5">-{{ totals.deleted }}</span>
        </span>
      </div>
      <p v-if="changes" class="mt-1 text-xs text-dimmed">
        Committed work at <span class="font-mono">{{ shortSha(changes.sha) }}</span
        >, against base
        <span class="font-mono">{{ shortSha(changes.baseSha) }}</span>
      </p>
    </template>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" class="m-4" />
    <div v-else-if="!changes" class="p-4 space-y-2">
      <USkeleton v-for="n in 3" :key="n" class="h-4 w-full" />
    </div>
    <p v-else-if="!changes.files.length" class="p-4 text-sm text-muted">Nothing committed on the task branch yet.</p>
    <ul v-else class="py-1 text-sm max-h-96 overflow-y-auto">
      <li v-for="row in shown" :key="row.key">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 py-1 pr-4 text-left hover:bg-elevated/50"
          :style="{ paddingLeft: `${1 + row.depth * 1}rem` }"
          :title="row.kind === 'file' && row.file.oldPath ? `Renamed from ${row.file.oldPath}` : undefined"
          @click="row.kind === 'folder' ? toggle(row.key) : show(row.file.path)"
        >
          <UIcon
            v-if="row.kind === 'folder'"
            name="i-lucide-chevron-right"
            class="size-3.5 shrink-0 text-dimmed transition-transform"
            :class="{ 'rotate-90': !closed.has(row.key) }"
          />
          <UIcon v-else name="i-lucide-file" class="size-3.5 shrink-0 text-dimmed" />
          <span class="truncate" :class="row.kind === 'folder' ? 'text-muted' : 'text-default'">{{ row.name }}</span>
          <UIcon
            v-if="row.kind === 'file' && row.file.oldPath"
            name="i-lucide-arrow-right-left"
            class="size-3 shrink-0 text-dimmed"
          />
          <span class="ml-auto shrink-0 font-mono text-xs">
            <template v-if="row.kind === 'file' && row.file.added === null">
              <span class="text-dimmed">binary</span>
            </template>
            <template v-else>
              <span class="text-success">+{{ row.kind === 'file' ? row.file.added : row.added }}</span>
              <span class="text-error ml-1.5">-{{ row.kind === 'file' ? row.file.deleted : row.deleted }}</span>
            </template>
          </span>
        </button>
      </li>
    </ul>

    <template v-if="changes?.files.length" #footer>
      <UButton variant="link" trailing-icon="i-lucide-arrow-right" class="px-0" @click="show(null)">
        View full diff
      </UButton>
    </template>
  </UCard>

  <UModal
    v-model:open="open"
    title="Full diff"
    :description="changes ? `${shortSha(changes.baseSha)} to ${shortSha(changes.sha)}` : undefined"
    :ui="{ content: 'sm:max-w-6xl', body: 'p-0 sm:p-0' }"
  >
    <template #body>
      <div ref="body" class="max-h-[75vh] overflow-auto">
        <UAlert v-if="diffError" color="error" variant="subtle" :title="diffError" class="m-4" />
        <div v-else-if="!diff" class="p-4 space-y-2">
          <USkeleton v-for="n in 6" :key="n" class="h-4 w-full" />
        </div>
        <template v-else>
          <UAlert
            v-if="diff.truncated"
            color="warning"
            variant="subtle"
            icon="i-lucide-scissors"
            title="The diff is cut short"
            description="It is longer than the dashboard shows (dashboardDiffBytes). Open the changed files in Orca to see the rest."
            class="m-4"
          />
          <section v-for="section in sections" :key="section.path" :data-path="section.path">
            <h4
              class="sticky top-0 z-10 border-y border-default bg-elevated px-4 py-1.5 font-mono text-xs font-semibold"
            >
              {{ section.path }}
            </h4>
            <pre class="font-mono text-xs leading-5 py-1"><div
              v-for="(line, index) in section.lines"
              :key="index"
              class="px-4 whitespace-pre"
              :class="lineClass(line)"
            >{{ line || ' ' }}</div></pre>
          </section>
        </template>
      </div>
    </template>
  </UModal>
</template>
