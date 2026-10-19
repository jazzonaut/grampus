<script setup lang="ts">
/**
 * NewTaskPage: describe a change and start planning. Creates the planning conversation
 * (`POST /api/kickoffs`: repository, request, provider, workspace adapter, reference folders and, when
 * inspected, the pinned base and starting file hints), then sends its first planning turn with the
 * server's `plan-message` action and opens the conversation. Also imports an authored plan JSON.
 */
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { CreatedResponse, InspectRepositoryResponse, KickoffDetailV1 } from '../../../src/server/api-types';
import { buildRequest } from '../api/actions';
import { ApiError, get, postUnkeyed, request as send } from '../api/client';
import { announce, useNow } from '../announcer';
import { href, navigate } from '../router';
import ImportPlan from '../components/ImportPlan.vue';
import NoticeBox from '../components/NoticeBox.vue';
import OrcaWorktreePicker from '../components/OrcaWorktreePicker.vue';
import ReferenceFolders from '../components/ReferenceFolders.vue';
import StartingFileHints from '../components/StartingFileHints.vue';
import { elapsedSince } from '../components/format';

defineOptions({ name: 'NewTaskPage' });

const repo = ref('');
const description = ref('');
const references = ref('');
const provider = ref<'codex' | 'claude'>('codex');
const adapter = ref<'git' | 'orca'>('git');
const preview = ref<InspectRepositoryResponse | null>(null);
const hints = ref('');
/** The repository folder as typed when it was inspected; hints apply only while it is unchanged. */
const previewFor = ref('');
watch(preview, inspected => {
  previewFor.value = inspected ? repo.value.trim() : '';
});
const startedAt = ref<string | null>(null);
const error = ref<{ message: string; issues: readonly string[] } | null>(null);
const now = useNow();

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

const canStart = computed(
  () => repo.value.trim() !== '' && description.value.trim() !== '' && startedAt.value === null,
);

/** The kickoff body: hints only when they were inspected for the repository still entered. */
function kickoffBody(): Record<string, unknown> {
  const folders = lines(references.value);
  const inspected = preview.value && repo.value.trim() === previewFor.value ? preview.value : null;
  return {
    repo: repo.value.trim(),
    request: description.value,
    provider: provider.value,
    adapter: adapter.value,
    ...(folders.length ? { references: folders } : {}),
    ...(inspected ? { base: inspected.base, contextFiles: lines(hints.value) } : {}),
  };
}

/** Sends the first planning turn exactly as the conversation's `plan-message` action describes. */
async function firstTurn(id: string): Promise<void> {
  const kickoff = await get<KickoffDetailV1>(`/api/v1/kickoffs/${id}`);
  const action = kickoff.actions.find(item => item.id === 'plan-message');
  if (!action) return;
  const built = buildRequest(action);
  if (built.ok) await send(built.method, built.path, built.body);
}

async function start(): Promise<void> {
  if (!canStart.value) return;
  error.value = null;
  startedAt.value = new Date().toISOString();
  announce('Preparing repository context.');
  let created: string | null = null;
  try {
    created = (await postUnkeyed<CreatedResponse>('/api/kickoffs', kickoffBody())).id;
    await firstTurn(created);
    navigate({ name: 'planning', id: created });
  } catch (caught) {
    const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
    if (created) navigate({ name: 'planning', id: created });
    else error.value = { message: apiError.message, issues: apiError.issues };
  } finally {
    startedAt.value = null;
  }
}
</script>

<template>
  <div class="grampus-page">
    <a :href="href({ name: 'home' })" class="text-sm text-muted hover:underline">← Overview</a>
    <header>
      <p class="text-xs font-medium tracking-wide text-muted uppercase">New task</p>
      <h1 class="text-3xl font-semibold tracking-tight text-highlighted">What would you like to change?</h1>
      <p class="mt-1 max-w-prose text-toned">
        Start with the outcome. The planner reads the committed repository and asks about details that could change the
        result.
      </p>
    </header>
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <form class="flex flex-col gap-4 grampus-surface" novalidate @submit.prevent="start">
        <div class="flex flex-col gap-1">
          <label for="new-repo" class="text-sm font-medium text-highlighted"
            >Repository folder <span class="sr-only">(required)</span></label
          >
          <input
            id="new-repo"
            v-model="repo"
            required
            class="grampus-input font-mono"
            placeholder="C:\Projects\my-project"
            spellcheck="false"
            aria-describedby="new-repo-help"
          />
          <p id="new-repo-help" class="text-xs text-muted">
            An existing Git repository with a committed baseline. You approve the exact files agents may change before
            implementation.
          </p>
          <OrcaWorktreePicker v-model="repo" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="new-request" class="text-sm font-medium text-highlighted"
            >What should be different when this is done? <span class="sr-only">(required)</span></label
          >
          <textarea
            id="new-request"
            v-model="description"
            required
            rows="6"
            class="grampus-input"
            placeholder="Describe the behaviour, include a few examples, and say what should stay the same."
          />
        </div>
        <ReferenceFolders v-model="references" :request="description" />
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-1">
            <label for="new-provider" class="text-sm font-medium text-highlighted">Planner and implementer</label>
            <select id="new-provider" v-model="provider" class="grampus-input" aria-describedby="new-provider-help">
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
            <p id="new-provider-help" class="text-xs text-muted">The other provider reviews the result.</p>
          </div>
          <div class="flex flex-col gap-1">
            <label for="new-adapter" class="text-sm font-medium text-highlighted">Workspace</label>
            <select id="new-adapter" v-model="adapter" class="grampus-input">
              <option value="git">Standalone Git worktree</option>
              <option value="orca">Local Orca worktree</option>
            </select>
          </div>
        </div>
        <p class="text-xs text-muted">
          Agents run until they finish or you choose Stop. There is no automatic time limit.
        </p>
        <StartingFileHints v-model:preview="preview" v-model:hints="hints" :repo="repo" :request="description" />
        <NoticeBox v-if="startedAt" tone="info" title="Preparing repository context" live="status">
          Inspecting the repository and pinning the files for planning. Elapsed {{ elapsedSince(startedAt, now) }}.
          Planning starts after the repository is ready.
        </NoticeBox>
        <NoticeBox v-if="error" tone="error" title="Planning could not start" live="alert">
          <p class="whitespace-pre-line">{{ error.message }}</p>
          <ul v-if="error.issues.length" class="list-disc pl-5">
            <li v-for="issue in error.issues" :key="issue">{{ issue }}</li>
          </ul>
        </NoticeBox>
        <UButton
          type="submit"
          :label="startedAt ? 'Inspecting repository…' : 'Start planning'"
          class="self-start"
          :disabled="!canStart"
          :loading="startedAt !== null"
        />
      </form>
      <aside class="flex flex-col gap-4" aria-label="About planning">
        <section class="grampus-surface text-sm">
          <h2 class="font-semibold text-highlighted">Before work begins</h2>
          <p class="mt-1 text-toned">
            Planning uses your existing subscription sign-in. You review the complete plan and authorize the exact files
            before implementation starts.
          </p>
          <p class="mt-2 text-xs text-muted">
            The other provider reviews the result. Routine check failures are repaired within the approved allowance.
            Commits stay local.
          </p>
        </section>
        <ImportPlan @created="id => navigate({ name: 'task', id })" />
      </aside>
    </div>
  </div>
</template>
