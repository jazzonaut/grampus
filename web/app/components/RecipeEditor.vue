<!--
  Edit one saved recipe. It is saved to config.json and validated by the server with the same rules
  `grampus` applies on startup; tasks already running keep the recipe they started with.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Recipe, DeliveryPolicy } from '../../../src/domain/recipe';
import { sendJson } from '../api/client';
import { useModels } from '../composables/useModels';
import AssignmentField from './AssignmentField.vue';

const props = defineProps<{
  recipe: Recipe | null;
  originalName: string | null;
  maxRounds: number;
  deliveryDefaults: DeliveryPolicy | null;
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ saved: [] }>();
const { catalogs, loading, refresh } = useModels();

const draft = ref<Recipe | null>(null);
const error = ref<string | null>(null);
const saving = ref(false);
watch(
  () => [open.value, props.recipe] as const,
  ([isOpen, recipe]) => {
    if (isOpen && recipe) draft.value = JSON.parse(JSON.stringify(recipe)) as Recipe;
    error.value = null;
  },
  { immediate: true },
);

const ownRepair = computed({
  get: () => draft.value?.repair.assignment !== undefined,
  set: value => {
    if (!draft.value) return;
    if (value) draft.value.repair.assignment = { ...draft.value.build };
    else delete draft.value.repair.assignment;
  },
});
const repairAssignment = computed({
  get: () => draft.value?.repair.assignment ?? null,
  set: value => {
    if (draft.value && value) draft.value.repair.assignment = value;
  },
});
const notes = computed(() => catalogs.value.flatMap(catalog => (catalog.note ? [catalog.note] : [])));
const boundedDelivery = computed({
  get: () => Boolean(draft.value?.delivery),
  set: enabled => {
    if (!draft.value) return;
    if (enabled && props.deliveryDefaults) draft.value.delivery = { ...props.deliveryDefaults };
    else delete draft.value.delivery;
  },
});
const unattended = computed({
  get: () => draft.value?.delivery?.mode === 'unattended',
  set: enabled => {
    if (draft.value?.delivery) draft.value.delivery.mode = enabled ? 'unattended' : 'supervised';
  },
});
const fallbackAssignment = computed({
  get: () => draft.value?.repair.fallback ?? null,
  set: value => {
    if (!draft.value) return;
    if (value) draft.value.repair.fallback = value;
    else delete draft.value.repair.fallback;
  },
});

async function save(): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  error.value = null;
  try {
    const target = encodeURIComponent(props.originalName ?? draft.value.name);
    await sendJson('PUT', `/api/recipes/${target}`, draft.value);
    emit('saved');
    open.value = false;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="originalName ? `Edit ${originalName}` : 'New recipe'"
    description="Which agent, model and effort runs each stage."
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form v-if="draft" id="recipe-form" class="space-y-4" @submit.prevent="save">
        <UFormField label="Name" required>
          <UInput v-model="draft.name" class="w-full" />
        </UFormField>

        <div class="rounded-lg border border-default p-3 space-y-3">
          <USwitch
            v-model="boundedDelivery"
            label="Use a delivery budget and automatic recovery"
            :disabled="!deliveryDefaults"
          />
          <template v-if="draft.delivery">
            <USwitch
              v-model="unattended"
              label="Finish without routine approvals"
              description="Requires independent spec and code review. Product decisions still come to you. Never merges or deploys."
            />
            <UFormField
              label="Time budget in seconds"
              help="Measured from task creation. Exhaustion produces an incomplete result."
            >
              <UInputNumber v-model="draft.delivery.maxSeconds" />
            </UFormField>
            <UFormField
              label="Estimated cost budget in USD"
              help="Optional. Checked before launching another worker; unknown usage stops further spending. A running worker can exceed the estimate."
            >
              <UInputNumber
                :model-value="draft.delivery.maxCostUsd ?? undefined"
                @update:model-value="draft.delivery.maxCostUsd = $event ?? null"
              />
            </UFormField>
            <UFormField label="Report corrections"><UInputNumber v-model="draft.delivery.reportRetries" /></UFormField>
            <UFormField label="Technical spec revisions"
              ><UInputNumber v-model="draft.delivery.specRevisions"
            /></UFormField>
            <UFormField label="Worker deadline (seconds)"
              ><UInputNumber v-model="draft.delivery.stageSeconds"
            /></UFormField>
            <UFormField label="Investigations per review"
              ><UInputNumber v-model="draft.delivery.investigations"
            /></UFormField>
            <UFormField label="Worker retries"><UInputNumber v-model="draft.delivery.stageRetries" /></UFormField>
            <UFormField label="Implementation questions resolved automatically"
              ><UInputNumber v-model="draft.delivery.questionResolutions"
            /></UFormField>
          </template>
        </div>

        <div class="flex items-center justify-between gap-2">
          <p class="text-xs text-muted">
            Models are read from the Claude and Codex CLIs. Type a name if yours is missing.
          </p>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="loading"
            label="Reload models"
            @click="refresh"
          />
        </div>
        <UAlert v-for="note in notes" :key="note" color="warning" variant="subtle" icon="i-lucide-info" :title="note" />

        <AssignmentField
          v-model="draft.spec"
          label="Spec"
          help="Investigates, asks you questions and writes the spec."
        />
        <AssignmentField
          v-model="draft.specReview"
          label="Spec review"
          help="Reviews the spec while you read it. Best from the other model family."
          optional
        />
        <AssignmentField
          v-model="draft.testsFirst"
          label="Tests first"
          help="Turns the spec examples into failing tests before the build."
          optional
        />
        <AssignmentField v-model="draft.build" label="Build" help="Implements the spec and commits." />
        <AssignmentField
          v-model="draft.review"
          label="Code review"
          help="Reviews the change against the spec. Best from the other model family."
          optional
        />

        <div class="rounded-lg border border-default p-3 space-y-3">
          <p class="text-sm font-medium">Repair</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="Automatic ordinary repairs" :help="`0 to ${maxRounds}, separate from coverage repairs`">
              <UInputNumber v-model="draft.repair.maxRounds" :min="0" :max="maxRounds" class="w-full" />
            </UFormField>
            <UFormField
              label="Rounds that continue the builder"
              help="Later rounds start fresh with a distilled problem list."
            >
              <UInputNumber v-model="draft.repair.reuseBuilderRounds" :min="0" :max="maxRounds" class="w-full" />
            </UFormField>
          </div>
          <UFormField
            label="Automatic coverage repairs"
            help="Separate allowance for coverage gaps with a concrete failing scenario. Zero asks you immediately; unknown evidence still needs you."
          >
            <UInputNumber v-model="draft.repair.coverageGapRounds" :min="0" :max="maxRounds" class="w-full" />
          </UFormField>
          <USwitch v-model="ownRepair" label="Use a different agent for repair than for the build" />
          <AssignmentField v-if="ownRepair" v-model="repairAssignment" label="Repair agent" />
          <AssignmentField
            v-model="fallbackAssignment"
            label="Fallback editor"
            help="Used after repeated failure without a decrease in unresolved findings. Verification stays unchanged."
            optional
          />
          <UFormField v-if="draft.repair.fallback" label="Stagnant rounds before fallback">
            <UInputNumber
              :model-value="draft.repair.stagnantRounds"
              @update:model-value="draft.repair.stagnantRounds = $event ?? undefined"
            />
          </UFormField>
        </div>

        <AssignmentField
          v-model="draft.polish"
          label="Polish"
          help="Improves names, duplication, structure and cleanup. Edits need passing checks and independent approval of safety and maintenance benefit."
          optional
        />

        <div class="rounded-lg border border-default p-3 space-y-3">
          <USwitch
            v-model="draft.explain.automatic"
            label="Explain the final candidate automatically"
            description="Runs after verification and a kept polish; explanations do not affect correctness."
          />
          <AssignmentField
            v-model="draft.explain.assignment"
            label="Explanation agent"
            help="Also answers follow-up questions in the Changes tab."
          />
        </div>

        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-x" :title="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="recipe-form" icon="i-lucide-save" label="Save recipe" :loading="saving" />
      </div>
    </template>
  </USlideover>
</template>
