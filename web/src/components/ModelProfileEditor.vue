<script setup lang="ts">
// Owns a profile editing draft; validation and independent-review rules remain on the server.
import { ref } from 'vue';
import type {
  ModelProfileV1,
  ModelAssignmentV1,
  ModelProfilesV1,
  ProviderModelsV1,
} from '../../../src/server/api-types';
import ModelAssignmentEditor from './ModelAssignmentEditor.vue';
const props = defineProps<{
  profile: ModelProfileV1;
  catalogue: ModelProfilesV1;
  models?: ProviderModelsV1 | undefined;
}>();
const emit = defineEmits<{ save: [profile: ModelProfileV1]; cancel: [] }>();
const draft = ref<ModelProfileV1>(JSON.parse(JSON.stringify(props.profile)) as ModelProfileV1);
const repair = ref(draft.value.repair !== undefined);
const arbitration = ref(draft.value.arbitration !== undefined);
function quality(id: string, assignment: ModelAssignmentV1): void {
  draft.value.qualityPasses = { ...draft.value.qualityPasses, [id]: assignment };
}
function toggleQuality(id: string, event: Event): void {
  const next = { ...draft.value.qualityPasses };
  if ((event.target as HTMLInputElement).checked) next[id] = { ...draft.value.implementation };
  draft.value.qualityPasses = (event.target as HTMLInputElement).checked
    ? next
    : Object.fromEntries(Object.entries(next).filter(([key]) => key !== id));
}
function save(): void {
  const result = { ...draft.value };
  if (!repair.value) delete result.repair;
  if (!arbitration.value) delete result.arbitration;
  emit('save', result);
}
</script>

<template>
  <form class="flex flex-col gap-4 grampus-surface" @submit.prevent="save">
    <label class="text-sm"
      >Profile identifier
      <input v-model="draft.id" class="grampus-input mt-1 w-full" required pattern="[a-z][a-z0-9_-]*"
    /></label>
    <label class="text-sm">Name <input v-model="draft.name" class="grampus-input mt-1 w-full" required /></label>
    <ModelAssignmentEditor v-model="draft.planning" label="Planning" :efforts="catalogue.efforts" :models="models" />
    <ModelAssignmentEditor
      v-model="draft.implementation"
      label="Implementation"
      :efforts="catalogue.efforts"
      :models="models"
    />
    <ModelAssignmentEditor
      v-model="draft.review"
      label="Independent review"
      :efforts="catalogue.efforts"
      :models="models"
    />
    <label class="text-sm"
      ><input v-model="repair" type="checkbox" @change="draft.repair ??= { ...draft.implementation }" /> Separate repair
      assignment</label
    >
    <ModelAssignmentEditor
      v-if="repair && draft.repair"
      v-model="draft.repair"
      label="Repair"
      :efforts="catalogue.efforts"
      :models="models"
    />
    <label class="text-sm"
      ><input v-model="arbitration" type="checkbox" @change="draft.arbitration ??= { ...draft.implementation }" />
      Enable fresh arbitration</label
    >
    <ModelAssignmentEditor
      v-if="arbitration && draft.arbitration"
      v-model="draft.arbitration"
      label="Arbitration"
      :efforts="catalogue.efforts"
      :models="models"
    />
    <div v-for="pass in catalogue.qualityPasses" :key="pass.id" class="flex flex-col gap-2">
      <label class="text-sm"
        ><input type="checkbox" :checked="!!draft.qualityPasses?.[pass.id]" @change="toggleQuality(pass.id, $event)" />
        Separate assignment for {{ pass.title }}</label
      >
      <ModelAssignmentEditor
        v-if="draft.qualityPasses?.[pass.id]"
        :model-value="draft.qualityPasses?.[pass.id] ?? draft.implementation"
        :label="pass.title"
        :efforts="catalogue.efforts"
        :models="models"
        @update:model-value="quality(pass.id, $event)"
      />
    </div>
    <p class="text-xs text-muted">
      Repair and edit passes use the implementation provider. Independent review uses the other provider. An omitted
      repair or edit assignment inherits implementation.
    </p>
    <div class="flex gap-3">
      <button type="submit" class="grampus-link-button">Save profile</button
      ><button type="button" class="grampus-link" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>
