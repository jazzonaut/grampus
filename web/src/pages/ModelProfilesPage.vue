<script setup lang="ts">
// Owns catalogue editing. Saved definitions are copied into new plans and cannot change existing runs.
import { onMounted, ref } from 'vue';
import type { ModelProfileV1, ModelProfilesV1, ProviderModelsV1 } from '../../../src/server/api-types';
import { get, postUnkeyed } from '../api/client';
import { usePolled } from '../api/usePolled';
import { pollIntervalMs } from '../settings';
import ModelProfileEditor from '../components/ModelProfileEditor.vue';
const catalogue = usePolled(() => get<ModelProfilesV1>('/api/v1/model-profiles'), pollIntervalMs);
const editing = ref<ModelProfileV1 | null>(null);
const originalId = ref<string | null>(null);
const error = ref('');
const busy = ref(false);
const models = ref<ProviderModelsV1>();
const modelsBusy = ref(false);
const modelsError = ref('');
async function loadModels(): Promise<void> {
  modelsBusy.value = true;
  modelsError.value = '';
  try {
    models.value = await get<ProviderModelsV1>('/api/v1/provider-models');
  } catch {
    modelsError.value = 'Model suggestions could not be loaded. Enter a model ID manually or use the provider default.';
  } finally {
    modelsBusy.value = false;
  }
}
onMounted(loadModels);
function edit(profile: ModelProfileV1): void {
  originalId.value = profile.id;
  editing.value = profile;
}
function create(): void {
  originalId.value = null;
  editing.value = {
    id: 'new-profile',
    name: 'New profile',
    planning: { provider: 'codex', model: null },
    implementation: { provider: 'codex', model: null },
    review: { provider: 'claude', model: null },
  };
}
async function save(profile: ModelProfileV1): Promise<void> {
  const data = catalogue.data.value;
  if (!data) return;
  busy.value = true;
  error.value = '';
  try {
    await postUnkeyed('/api/model-profiles', {
      expected: data.expected,
      profiles: [...data.profiles.filter(item => item.id !== originalId.value), profile],
    });
    editing.value = null;
    await catalogue.refresh();
  } catch (caught) {
    error.value = String(caught);
  } finally {
    busy.value = false;
  }
}
async function remove(profile: ModelProfileV1): Promise<void> {
  const data = catalogue.data.value;
  if (!data) return;
  try {
    await postUnkeyed('/api/model-profiles', {
      expected: data.expected,
      profiles: data.profiles.filter(item => item.id !== profile.id),
    });
    await catalogue.refresh();
  } catch (caught) {
    error.value = String(caught);
  }
}
</script>

<template>
  <div class="grampus-page">
    <h1 class="text-3xl font-semibold">Model profiles</h1>
    <p>Choose fixed models and reasoning effort for each role. Approved tasks retain their own copy.</p>
    <div class="flex items-center gap-3 text-sm">
      <button type="button" class="grampus-link" :disabled="modelsBusy" @click="loadModels">Refresh model list</button>
      <span v-if="modelsBusy" role="status">Loading model suggestions from local agents…</span>
    </div>
    <p class="text-sm text-muted">
      Choose a suggested model or type its ID. Listed models are checked when a task runs.
    </p>
    <p v-if="modelsError" role="status" class="text-sm text-muted">{{ modelsError }}</p>
    <p v-if="models?.codex.problem" role="status" class="text-sm text-muted">Codex: {{ models.codex.problem }}</p>
    <p v-if="models?.claude.problem" role="status" class="text-sm text-muted">Claude: {{ models.claude.problem }}</p>
    <p v-if="error || catalogue.error.value" role="alert" class="text-error">
      {{ error || catalogue.error.value?.message }}
    </p>
    <p v-if="catalogue.data.value?.problem" role="alert">{{ catalogue.data.value.problem }}</p>
    <template v-if="catalogue.data.value">
      <ModelProfileEditor
        v-if="editing"
        :key="originalId ?? 'new'"
        :profile="editing"
        :catalogue="catalogue.data.value"
        :models="models"
        @save="save"
        @cancel="editing = null"
      />
      <template v-else>
        <button
          class="grampus-link-button self-start"
          :disabled="!catalogue.data.value.editable || busy"
          @click="create"
        >
          Create profile
        </button>
        <p v-if="!catalogue.data.value.editable" class="text-muted">
          Start the dashboard with its settings directory to save profiles.
        </p>
        <p v-if="!catalogue.data.value.profiles.length">
          No profiles yet. Create two to compare them on a shared plan.
        </p>
        <article v-for="profile in catalogue.data.value.profiles" :key="profile.id" class="grampus-surface">
          <h2 class="text-xl font-medium">{{ profile.name }}</h2>
          <p class="text-sm text-muted">
            {{ profile.implementation.provider }} · {{ profile.implementation.model ?? 'Provider default' }} ·
            {{ profile.implementation.effort ?? 'Default effort' }}
          </p>
          <div class="mt-3 flex gap-4">
            <button class="grampus-link" @click="edit(profile)">Edit</button
            ><button class="grampus-link" :disabled="!catalogue.data.value.editable" @click="remove(profile)">
              Remove from catalogue
            </button>
          </div>
        </article>
      </template>
    </template>
  </div>
</template>
