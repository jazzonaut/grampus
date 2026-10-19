<script setup lang="ts">
/**
 * OrcaWorktreePicker: fills the repository folder from a local Orca worktree. The server lists the
 * worktrees grouped by repository with their full paths (`GET /api/v1/orca-worktrees`), so two worktrees
 * both called `main` stay distinguishable. Orca is optional: when it is absent or does not answer, nothing
 * is drawn and the folder is typed as before. Choosing only fills the field; the server inspects it later.
 *
 * `v-model` is the repository folder text.
 */
import { computed, onMounted, ref, useId } from 'vue';
import type { OrcaWorktreesV1 } from '../../../src/server/api-types';
import { get } from '../api/client';

defineOptions({ name: 'OrcaWorktreePicker' });

const folder = defineModel<string>({ required: true });

const id = useId();
const choices = ref<OrcaWorktreesV1 | null>(null);
const shown = computed(() => (choices.value?.available && choices.value.repositories.length ? choices.value : null));

onMounted(async () => {
  try {
    choices.value = await get<OrcaWorktreesV1>('/api/v1/orca-worktrees');
  } catch {
    // An unreachable or older server simply offers no Orca choice.
    choices.value = null;
  }
});

function choose(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (select.value) folder.value = select.value;
  select.value = '';
}
</script>

<template>
  <div v-if="shown" class="flex flex-col gap-1" data-panel="orca-worktrees">
    <label :for="id" class="text-xs font-medium text-toned">Or choose an Orca worktree</label>
    <select :id="id" class="grampus-input text-sm" @change="choose">
      <option value="">Choose a worktree…</option>
      <optgroup v-for="(repository, index) in shown.repositories" :key="index" :label="repository.name">
        <option v-for="worktree in repository.worktrees" :key="worktree.path" :value="worktree.path">
          {{ worktree.label }}: {{ worktree.path }}
        </option>
      </optgroup>
    </select>
    <p v-if="shown.omitted" class="text-xs text-muted">
      {{ shown.omitted }} more {{ shown.omitted === 1 ? 'worktree is' : 'worktrees are' }} not listed; type the folder
      instead.
    </p>
  </div>
</template>
