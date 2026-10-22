<!--
  Start a task, like `grampus new`: pick a repository (recent ones first, then the ones Orca knows, or any
  path), describe the outcome, choose a recipe. Grampus then creates the worktree and starts the driver.
-->
<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Recipe } from '../../../src/domain/recipe';
import { getJson, sendJson } from '../api/client';

interface RepoChoice {
  path: string;
  name: string;
  recent: boolean;
}

const router = useRouter();
const toast = useToast();

const repos = ref<RepoChoice[]>([]);
const repoNote = ref<string | null>(null);
const recipes = ref<Recipe[]>([]);
const repo = ref<string | undefined>(undefined);
const request = ref('');
const title = ref('');
const recipe = ref('standard');
const creating = ref(false);
const error = ref<string | null>(null);

getJson<{ repos: RepoChoice[]; note: string | null }>('/api/repos').then(
  value => {
    repos.value = value.repos;
    repoNote.value = value.note;
    repo.value ??= value.repos[0]?.path;
  },
  (failure: unknown) => (repoNote.value = (failure as Error).message),
);
getJson<{ recipes: Recipe[] }>('/api/recipes').then(
  value => (recipes.value = value.recipes),
  () => undefined,
);

const repoItems = computed(() =>
  repos.value.map(choice => ({
    label: choice.name,
    value: choice.path,
    description: choice.path,
    icon: choice.recent ? 'i-lucide-history' : 'i-lucide-folder-git-2',
  })),
);
const recipeItems = computed(() => recipes.value.map(item => ({ label: item.name, value: item.name })));

function addPath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  repos.value = [{ path: trimmed, name: trimmed, recent: false }, ...repos.value];
  repo.value = trimmed;
}

async function create(): Promise<void> {
  if (!repo.value || !request.value.trim()) return;
  creating.value = true;
  error.value = null;
  try {
    const created = await sendJson<{ taskId: string }>('POST', '/api/tasks', {
      repo: repo.value,
      request: request.value,
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
      recipe: recipe.value,
    });
    toast.add({
      title: 'Task started',
      description: 'The spec writer starts shortly; its questions come to you here.',
      icon: 'i-lucide-rocket',
      color: 'success',
    });
    await router.push(`/tasks/${created.taskId}`);
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <UDashboardPanel id="new-task">
    <template #header>
      <UDashboardNavbar title="New task" icon="i-lucide-plus">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <form class="max-w-2xl space-y-5" @submit.prevent="create">
        <UFormField
          label="Repository"
          required
          :help="repoNote ?? 'Recent repositories first. Type a path to use another.'"
        >
          <USelectMenu
            v-model="repo"
            :items="repoItems"
            value-key="value"
            create-item
            placeholder="Choose or type a repository path"
            icon="i-lucide-folder-git-2"
            class="w-full"
            @create="addPath"
          />
        </UFormField>

        <UFormField
          label="What should be true when it is done?"
          required
          help="Plain language. The spec writer asks about anything ambiguous."
        >
          <UTextarea
            v-model="request"
            :rows="8"
            autoresize
            placeholder="Add CSV export to the reports page, with the same columns as the table..."
            class="w-full"
          />
        </UFormField>

        <div class="grid gap-5 sm:grid-cols-2">
          <UFormField label="Title" help="Optional; the first line of the request otherwise.">
            <UInput v-model="title" placeholder="CSV export" class="w-full" />
          </UFormField>
          <UFormField label="Recipe" help="Which agents and models run each stage.">
            <USelect v-model="recipe" :items="recipeItems" icon="i-lucide-chef-hat" class="w-full" />
          </UFormField>
        </div>

        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-x" :title="error" />

        <div class="flex items-center gap-3">
          <UButton
            type="submit"
            icon="i-lucide-rocket"
            label="Start task"
            :loading="creating"
            :disabled="!repo || !request.trim()"
          />
          <span v-if="creating" class="text-sm text-muted">Creating the worktree and starting the driver...</span>
        </div>
      </form>
    </template>
  </UDashboardPanel>
</template>
