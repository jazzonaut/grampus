<script setup lang="ts">
// Owns one provider/model/effort input. Supported effort choices come from the server catalogue.
import type { ModelAssignmentV1, ModelProfilesV1 } from '../../../src/server/api-types';
const props = defineProps<{ label: string; modelValue: ModelAssignmentV1; efforts: ModelProfilesV1['efforts'] }>();
const emit = defineEmits<{ 'update:modelValue': [value: ModelAssignmentV1] }>();
function provider(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as ModelAssignmentV1['provider'];
  emit('update:modelValue', { provider: value, model: null });
}
function model(event: Event): void {
  emit('update:modelValue', { ...props.modelValue, model: (event.target as HTMLInputElement).value.trim() || null });
}
function effort(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const base = { provider: props.modelValue.provider, model: props.modelValue.model };
  emit('update:modelValue', value ? { ...base, effort: value as NonNullable<ModelAssignmentV1['effort']> } : base);
}
</script>

<template>
  <fieldset class="grid gap-2 rounded border border-default p-3 sm:grid-cols-3">
    <legend class="px-1 text-sm font-medium">{{ label }}</legend>
    <label class="text-xs"
      >Provider
      <select :value="modelValue.provider" class="grampus-input mt-1 w-full" @change="provider">
        <option value="codex">Codex</option>
        <option value="claude">Claude</option>
      </select>
    </label>
    <label class="text-xs"
      >Model
      <input
        :value="modelValue.model ?? ''"
        class="grampus-input mt-1 w-full"
        placeholder="Provider default"
        @input="model"
      />
    </label>
    <label class="text-xs"
      >Reasoning effort
      <select :value="modelValue.effort ?? ''" class="grampus-input mt-1 w-full" @change="effort">
        <option value="">Provider default</option>
        <option v-for="value in efforts[modelValue.provider]" :key="value" :value="value">{{ value }}</option>
      </select>
    </label>
  </fieldset>
</template>
