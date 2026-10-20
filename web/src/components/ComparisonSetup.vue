<script setup lang="ts">
// Owns selection of saved profile snapshots against the task's displayed plan digest.
import { ref } from 'vue';
import type { CreatedResponse, ModelProfilesV1 } from '../../../src/server/api-types';
import { get, postUnkeyed } from '../api/client';
import { usePolled } from '../api/usePolled';
import { pollIntervalMs } from '../settings';
import { navigate } from '../router';
const props = defineProps<{ id: string; digest: string }>();
const catalogue = usePolled(() => get<ModelProfilesV1>('/api/v1/model-profiles'), pollIntervalMs);
const selected = ref<string[]>([]),
  error = ref(''),
  busy = ref(false);
async function create(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const response = await postUnkeyed<CreatedResponse>('/api/comparisons', {
      sourceTaskId: props.id,
      expectedDigest: props.digest,
      profiles: catalogue.data.value?.profiles.filter(profile => selected.value.includes(profile.id)) ?? [],
    });
    navigate({ name: 'comparison', id: response.id });
  } catch (caught) {
    error.value = String(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details class="grampus-surface">
    <summary class="cursor-pointer font-semibold">Compare model profiles on this plan</summary>
    <p class="mt-3 text-sm text-muted">
      Runs start from the same commit in separate worktrees and execute one after another. Review all configurations
      before approving.
    </p>
    <div class="my-3 flex flex-col gap-2">
      <label v-for="profile in catalogue.data.value?.profiles ?? []" :key="profile.id"
        ><input v-model="selected" type="checkbox" :value="profile.id" /> {{ profile.name }}</label
      >
    </div>
    <p v-if="!catalogue.data.value?.profiles.length">
      Create profiles on the <a href="#/profiles" class="grampus-link">Model profiles screen</a>.
    </p>
    <button :disabled="busy" class="grampus-link-button" @click="create">Prepare comparison for approval</button>
    <p v-if="error || catalogue.error.value" role="alert" class="mt-2 text-error">
      {{ error || catalogue.error.value?.message }}
    </p>
  </details>
</template>
