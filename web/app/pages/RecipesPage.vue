<!-- Recipes: the built-in one and the saved ones, with each stage's agent, model and effort at a glance. -->
<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables';
import { ref } from 'vue';
import type { Assignment, Recipe } from '../../../src/domain/recipe';
import { getJson, sendJson } from '../api/client';
import RecipeEditor from '../components/RecipeEditor.vue';

const toast = useToast();
const recipes = ref<Recipe[]>([]);
const builtIn = ref('standard');
const maxRounds = ref(0);
const error = ref<string | null>(null);
const editing = ref<{ recipe: Recipe; originalName: string | null } | null>(null);
const editorOpen = ref(false);
const deleting = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    const value = await getJson<{ recipes: Recipe[]; builtIn: string; maxRepairRounds: number }>('/api/recipes');
    recipes.value = value.recipes;
    builtIn.value = value.builtIn;
    maxRounds.value = value.maxRepairRounds;
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  }
}
void load();

function edit(recipe: Recipe, copy: boolean): void {
  const name = copy ? uniqueName(`${recipe.name}-copy`) : recipe.name;
  editing.value = { recipe: { ...recipe, name }, originalName: copy ? null : recipe.name };
  editorOpen.value = true;
}

/** A new recipe starts as a copy of the built-in one. */
function create(): void {
  const base = recipes.value.find(recipe => recipe.name === builtIn.value) ?? recipes.value[0];
  if (base) edit(base, true);
}

function uniqueName(base: string): string {
  let name = base;
  for (let n = 2; recipes.value.some(recipe => recipe.name === name); n++) name = `${base}-${n}`;
  return name;
}

async function remove(name: string): Promise<void> {
  deleting.value = null;
  try {
    await sendJson('DELETE', `/api/recipes/${encodeURIComponent(name)}`);
    toast.add({ title: `Deleted ${name}`, icon: 'i-lucide-trash-2', color: 'neutral' });
    await load();
  } catch (failure) {
    toast.add({ title: 'Not deleted', description: (failure as Error).message, color: 'error' });
  }
}

function describe(assignment: Assignment | null | undefined): string {
  if (!assignment) return 'off';
  return [assignment.agent, assignment.model ?? 'default model', assignment.effort].filter(Boolean).join(' · ');
}

function stages(recipe: Recipe): { label: string; icon: string; value: string }[] {
  return [
    { label: 'Spec', icon: 'i-lucide-file-text', value: describe(recipe.spec) },
    { label: 'Spec review', icon: 'i-lucide-file-search', value: describe(recipe.specReview) },
    { label: 'Tests first', icon: 'i-lucide-flask-conical', value: describe(recipe.testsFirst) },
    { label: 'Build', icon: 'i-lucide-hammer', value: describe(recipe.build) },
    { label: 'Review', icon: 'i-lucide-scan-eye', value: describe(recipe.review) },
    {
      label: 'Repair',
      icon: 'i-lucide-wrench',
      value: `${recipe.repair.maxRounds} rounds, ${recipe.repair.reuseBuilderRounds} continuing${
        recipe.repair.assignment ? `, ${describe(recipe.repair.assignment)}` : ''
      }`,
    },
  ];
}
</script>

<template>
  <UDashboardPanel id="recipes">
    <template #header>
      <UDashboardNavbar title="Recipes" icon="i-lucide-chef-hat">
        <template #right>
          <UButton icon="i-lucide-plus" label="New recipe" :disabled="!recipes.length" @click="create" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-5xl space-y-4">
        <p class="text-sm text-muted">
          A recipe says which agent, model and effort runs each stage. A task copies its recipe when it starts, so
          editing one never changes a running task. Saved recipes live in config.json.
        </p>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <div class="grid gap-4 lg:grid-cols-2">
          <UCard v-for="recipe in recipes" :key="recipe.name">
            <template #header>
              <div class="flex items-center gap-2">
                <h3 class="font-semibold">{{ recipe.name }}</h3>
                <UBadge v-if="recipe.name === builtIn" variant="subtle" color="neutral" icon="i-lucide-lock"
                  >built in</UBadge
                >
                <div class="ml-auto flex gap-1">
                  <UTooltip text="Copy">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-copy"
                      aria-label="Copy"
                      @click="edit(recipe, true)"
                    />
                  </UTooltip>
                  <template v-if="recipe.name !== builtIn">
                    <UTooltip text="Edit">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-pencil"
                        aria-label="Edit"
                        @click="edit(recipe, false)"
                      />
                    </UTooltip>
                    <UTooltip text="Delete">
                      <UButton
                        size="xs"
                        color="error"
                        variant="ghost"
                        icon="i-lucide-trash-2"
                        aria-label="Delete"
                        @click="deleting = recipe.name"
                      />
                    </UTooltip>
                  </template>
                </div>
              </div>
            </template>
            <dl class="space-y-1.5">
              <div v-for="stage in stages(recipe)" :key="stage.label" class="flex items-center gap-2 text-sm">
                <UIcon :name="stage.icon" class="size-4 text-muted shrink-0" />
                <dt class="w-24 shrink-0 text-muted">{{ stage.label }}</dt>
                <dd class="font-mono text-xs truncate" :class="stage.value === 'off' ? 'text-dimmed' : ''">
                  {{ stage.value }}
                </dd>
              </div>
            </dl>
          </UCard>
        </div>
      </div>

      <RecipeEditor
        v-model:open="editorOpen"
        :recipe="editing?.recipe ?? null"
        :original-name="editing?.originalName ?? null"
        :max-rounds="maxRounds"
        @saved="load"
      />

      <UModal
        :open="deleting !== null"
        :title="`Delete ${deleting}?`"
        description="Tasks that used it keep their copy."
        @update:open="(value: boolean) => !value && (deleting = null)"
      >
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="deleting = null" />
            <UButton color="error" icon="i-lucide-trash-2" label="Delete" @click="deleting && remove(deleting)" />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
