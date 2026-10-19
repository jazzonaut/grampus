<script setup lang="ts">
/**
 * PlanningContext: what the planner can see in a planning conversation: the repository, base, provider
 * and workspace, the starting file hints (editable, with a search of the pinned inventory), the read-only
 * reference folders (editable, with suggestions to add), exploration so far and MCP connections. Changing
 * hints or references invalidates the proposal and starts no inference.
 *
 * Props:
 * - `kickoff`: the `KickoffDetailV1`.
 * - `busy`, `sending`, `issuesFor`: from `useActions`.
 *
 * Emits `run` with the action (`update-context` or `update-references`) and its drafts.
 */
import { computed } from 'vue';
import type { ActionView, KickoffDetailV1 } from '../../../src/server/api-types';
import type { FieldIssue, FormDrafts } from '../api/actions';
import DecisionCard from './DecisionCard.vue';
import EvidenceSection from './EvidenceSection.vue';
import ExplorationSummary from './ExplorationSummary.vue';
import FileSearch from './FileSearch.vue';
import { formatCount, plural, short } from './format';

defineOptions({ name: 'PlanningContext' });

const props = defineProps<{
  kickoff: KickoffDetailV1;
  busy: boolean;
  sending: string | null;
  issuesFor: (actionId: string) => FieldIssue[];
}>();

const emit = defineEmits<{ run: [action: ActionView, drafts: FormDrafts] }>();

const contextAction = computed(() => props.kickoff.actions.find(item => item.id === 'update-context'));
const referencesAction = computed(() => props.kickoff.actions.find(item => item.id === 'update-references'));
const context = computed(() => props.kickoff.context);
</script>

<template>
  <div class="flex flex-col gap-3" data-panel="planning-context">
    <section aria-labelledby="access-heading" class="flex flex-col gap-2 rounded-lg border border-default p-4 text-sm">
      <h2 id="access-heading" class="text-base font-semibold text-highlighted">Repository access</h2>
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt class="text-muted">Repository</dt>
        <dd class="font-mono text-xs break-all">{{ kickoff.repository.path }}</dd>
        <dt class="text-muted">Base</dt>
        <dd class="font-mono text-xs" :title="kickoff.base">{{ short(kickoff.base) }}</dd>
        <dt class="text-muted">Planner</dt>
        <dd>{{ kickoff.provider.label }} plans and implements; the other provider reviews</dd>
        <dt class="text-muted">Workspace</dt>
        <dd>{{ kickoff.adapter === 'orca' ? 'Local Orca worktree' : 'Standalone Git worktree' }}</dd>
      </dl>
      <p class="text-toned">
        <template v-if="context.totalFiles !== null"
          >{{ plural(context.totalFiles, 'file') }} in the pinned commit;
        </template>
        {{ plural(context.files.length, 'file') }} supplied initially.
        {{
          context.exploration
            ? 'The planner searches and reads the rest itself.'
            : 'The planner uses the selected files only.'
        }}
      </p>
      <details v-if="context.directories.length">
        <summary class="cursor-pointer text-toned select-none">Repository map</summary>
        <pre class="grampus-code mt-1 max-h-64">{{
          context.directories.map(item => `${item.path}: ${item.files} files`).join('\n')
        }}</pre>
        <p v-if="context.inventoryDigest" class="mt-1 text-xs text-muted">
          Inventory digest: {{ context.inventoryDigest }}
        </p>
      </details>
    </section>
    <DecisionCard
      v-if="contextAction"
      :action="contextAction"
      :busy="busy"
      :sending="sending === 'update-context'"
      :issues="issuesFor('update-context')"
      @run="drafts => contextAction && emit('run', contextAction, drafts)"
    >
      <template #field-extra="{ field, append }">
        <FileSearch v-if="field.input === 'lines'" :repo="kickoff.repository.path" :base="kickoff.base" @add="append" />
      </template>
    </DecisionCard>
    <DecisionCard
      v-if="referencesAction"
      :action="referencesAction"
      :busy="busy"
      :sending="sending === 'update-references'"
      :issues="issuesFor('update-references')"
      @run="drafts => referencesAction && emit('run', referencesAction, drafts)"
    >
      <template #field-extra="{ field, append }">
        <ul
          v-if="field.input === 'lines' && kickoff.referenceSuggestions.length"
          class="flex flex-col gap-1"
          aria-label="Suggested reference folders"
        >
          <li v-for="item in kickoff.referenceSuggestions" :key="item.path">
            <button
              type="button"
              class="grampus-link-button w-full flex-col items-start text-left"
              @click="append(item.path)"
            >
              <span class="font-mono text-xs break-all">Add {{ item.path }}</span>
              <span class="text-xs font-normal text-muted">{{ item.reason }}</span>
            </button>
          </li>
        </ul>
      </template>
    </DecisionCard>
    <section v-if="kickoff.references.length && !referencesAction" class="rounded-lg border border-default p-4 text-sm">
      <h2 class="text-base font-semibold text-highlighted">Read-only references</h2>
      <ul class="mt-1 flex flex-col gap-1">
        <li v-for="reference in kickoff.references" :key="reference.path">
          <span class="font-mono text-xs break-all">{{ reference.path }}</span>
          <span class="text-xs text-muted"> · {{ formatCount(reference.files) }} files</span>
        </li>
      </ul>
    </section>
    <EvidenceSection title="Repository exploration" :summary="plural(kickoff.exploration.calls, 'call')">
      <ExplorationSummary :exploration="kickoff.exploration" :integrations="kickoff.integrations" />
    </EvidenceSection>
  </div>
</template>
