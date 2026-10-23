<!-- A compact entry to the complete Changes workspace. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChangesView } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { shortSha } from '../presentation';
import ChangedFileTree from './ChangedFileTree.vue';

const props = defineProps<{ taskId: string; updatedAt: string }>();
const emit = defineEmits<{ show: [tab: string] }>();
const changes = ref<ChangesView | null>(null);
const error = ref<string | null>(null);
watch(
  () => [props.taskId, props.updatedAt],
  async () => {
    try {
      changes.value = await getJson<ChangesView>(`/api/tasks/${encodeURIComponent(props.taskId)}/changes`);
      error.value = null;
    } catch (failure) {
      error.value = (failure as Error).message;
    }
  },
  { immediate: true },
);
const totals = computed(() => ({
  added: changes.value?.files.reduce((sum, file) => sum + (file.added ?? 0), 0) ?? 0,
  deleted: changes.value?.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0) ?? 0,
}));
</script>

<template>
  <UCard>
    <template #header>
      <h3 class="font-semibold flex items-center gap-2">
        <UIcon name="i-lucide-file-diff" class="size-4" /> Files changed
        <UBadge v-if="changes" size="sm" color="neutral" variant="subtle">{{ changes.files.length }}</UBadge>
      </h3>
      <p v-if="changes" class="text-xs text-muted mt-1">
        Committed work at {{ shortSha(changes.sha) }} against {{ shortSha(changes.baseSha) }}
      </p>
    </template>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div v-else-if="!changes" class="space-y-2"><USkeleton v-for="n in 3" :key="n" class="h-4" /></div>
    <p v-else-if="!changes.files.length" class="text-sm text-muted">Nothing committed on the task branch yet.</p>
    <template v-else>
      <p class="font-mono text-sm">
        <span class="text-success">+{{ totals.added }}</span> <span class="text-error">-{{ totals.deleted }}</span>
      </p>
      <ChangedFileTree :files="changes.files" class="mt-2 max-h-80 overflow-auto" />
    </template>
    <template #footer
      ><UButton variant="link" trailing-icon="i-lucide-arrow-right" class="px-0" @click="emit('show', 'changes')"
        >Explore changes</UButton
      ></template
    >
  </UCard>
</template>
