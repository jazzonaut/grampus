<script setup lang="ts">
// Owns choosing a saved snapshot for a new task. The server validates all effective assignments.
import { useId } from 'vue';
import type { ModelProfileV1, ModelProfilesV1 } from '../../../src/server/api-types';
import { get } from '../api/client';
import { usePolled } from '../api/usePolled';
import { pollIntervalMs } from '../settings';
const inputId = useId();
const props = defineProps<{ modelValue: ModelProfileV1 | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: ModelProfileV1 | null] }>();
const catalogue = usePolled(() => get<ModelProfilesV1>('/api/v1/model-profiles'), pollIntervalMs);
function choose(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  emit('update:modelValue', catalogue.data.value?.profiles.find(profile => profile.id === id) ?? null);
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <label :for="inputId" class="text-sm font-medium"
      >Model profile
      <select :id="inputId" :value="props.modelValue?.id ?? ''" class="grampus-input mt-1 w-full" @change="choose">
        <option value="">Use provider defaults</option>
        <option v-for="profile in catalogue.data.value?.profiles ?? []" :key="profile.id" :value="profile.id">
          {{ profile.name }}
        </option>
      </select>
    </label>
    <p class="text-xs text-muted">
      Fixed models and reasoning effort for planning, implementation and review.
      <a href="#/profiles" class="grampus-link">Manage profiles</a>
    </p>
    <p v-if="catalogue.error.value" class="text-error" role="alert">{{ catalogue.error.value.message }}</p>
  </div>
</template>
