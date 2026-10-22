<!--
  One stage's launch choice: agent, model and effort. Models come from the agent's own CLI; any other model
  name can be typed. An empty model means the user's Orca default, and an effort needs a model.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { Assignment } from '../../../src/domain/recipe';
import { useModels } from '../composables/useModels';

defineProps<{ label: string; help?: string; optional?: boolean }>();
const model = defineModel<Assignment | null>({ required: true });
const { catalogs } = useModels();

/** Select menus cannot hold an empty value, so "use the default" has its own marker. */
const unset = ':default';

const enabled = computed({
  get: () => model.value !== null,
  set: value => (model.value = value ? { agent: 'claude' } : null),
});

const catalog = computed(() => catalogs.value.find(item => item.agent === model.value?.agent));
const modelItems = computed(() => {
  const listed = catalog.value?.models.map(choice => ({ label: choice.label, value: choice.id })) ?? [];
  const current = model.value?.model;
  const extra = current && !listed.some(item => item.value === current) ? [{ label: current, value: current }] : [];
  return [{ label: 'Orca default', value: unset }, ...extra, ...listed];
});
const effortItems = computed(() => {
  const chosen = catalog.value?.models.find(choice => choice.id === model.value?.model);
  const efforts = chosen?.efforts.length ? chosen.efforts : (catalog.value?.efforts ?? []);
  return [{ label: 'Default', value: unset }, ...efforts.map(effort => ({ label: effort, value: effort }))];
});

function update(raw: Partial<Record<'agent' | 'model' | 'effort', string>>): void {
  const patch = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value === unset ? '' : value]));
  const current = model.value;
  if (!current) return;
  const agent = (patch.agent ?? current.agent) as Assignment['agent'];
  // Switching agent clears model and effort: they belong to the other agent.
  const chosenModel = patch.agent ? '' : (patch.model ?? current.model ?? '');
  const effort =
    patch.agent || patch.model !== undefined ? (patch.effort ?? '') : (patch.effort ?? current.effort ?? '');
  model.value = {
    agent,
    ...(chosenModel ? { model: chosenModel } : {}),
    ...(chosenModel && effort ? { effort } : {}),
  };
}
</script>

<template>
  <div class="rounded-lg border border-default p-3 space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div>
        <p class="text-sm font-medium">{{ label }}</p>
        <p v-if="help" class="text-xs text-muted">{{ help }}</p>
      </div>
      <USwitch v-if="optional" v-model="enabled" :label="enabled ? 'On' : 'Off'" />
    </div>
    <div v-if="model" class="grid gap-2 sm:grid-cols-3">
      <USelect
        :model-value="model.agent"
        :items="[
          { label: 'Claude', value: 'claude', icon: 'i-lucide-sparkle' },
          { label: 'Codex', value: 'codex', icon: 'i-lucide-code-xml' },
        ]"
        aria-label="Agent"
        @update:model-value="value => update({ agent: String(value) })"
      />
      <USelectMenu
        :model-value="model.model ?? unset"
        :items="modelItems"
        value-key="value"
        create-item
        placeholder="Model"
        aria-label="Model"
        @update:model-value="value => update({ model: String(value ?? '') })"
        @create="value => update({ model: value.trim() })"
      />
      <USelect
        :model-value="model.effort ?? unset"
        :items="effortItems"
        :disabled="!model.model"
        aria-label="Effort"
        @update:model-value="value => update({ effort: String(value ?? '') })"
      />
    </div>
  </div>
</template>
