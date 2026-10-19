<script setup lang="ts">
/** Owns the conversation's compact resource rail. Expensive context and usage render on demand. */
import type { ActionView, KickoffDetailV1 } from '../../../src/server/api-types';
import type { FieldIssue, FormDrafts } from '../api/actions';
import ActionButton from './ActionButton.vue';
import EvidenceSection from './EvidenceSection.vue';
import PlanningContext from './PlanningContext.vue';
import UsageSummary from './UsageSummary.vue';
import SectionHeading from './SectionHeading.vue';
defineProps<{
  kickoff: KickoffDetailV1;
  busy: boolean;
  sending: string | null;
  issuesFor: (id: string) => FieldIssue[];
}>();
const emit = defineEmits<{ run: [action: ActionView, drafts: FormDrafts]; proposal: [] }>();
</script>

<template>
  <aside class="flex min-w-0 flex-col gap-4" aria-label="Planning resources">
    <section class="grampus-surface">
      <SectionHeading title="At a glance" icon="i-lucide-sparkles" />
      <dl class="grid grid-cols-[1fr_auto] gap-3 text-sm">
        <dt class="text-toned">Open questions</dt>
        <dd>{{ kickoff.questions.length }}</dd>
        <dt class="text-toned">Starting file hints</dt>
        <dd>{{ kickoff.context.files.length }}</dd>
        <dt class="text-toned">Reference folders</dt>
        <dd>{{ kickoff.references.length }}</dd>
        <dt class="text-toned">Repository calls</dt>
        <dd>{{ kickoff.exploration.calls }}</dd>
        <dt class="text-toned">Connected MCP servers</dt>
        <dd>{{ kickoff.integrations.length }}</dd>
      </dl>
    </section>
    <section v-if="kickoff.proposal" class="rounded-xl border border-primary/20 bg-primary/5 p-5">
      <p class="font-semibold text-primary">A proposal is available</p>
      <p class="mt-2 text-sm text-toned">
        Inspect its outcome, file permissions and checks before creating a task for approval.
      </p>
      <button type="button" class="grampus-link-button mt-4 w-full justify-center" @click="emit('proposal')">
        View proposal <span aria-hidden="true">→</span>
      </button>
    </section>
    <EvidenceSection title="Context and resources" :summary="`${kickoff.context.files.length} file hints`">
      <PlanningContext
        :kickoff="kickoff"
        :busy="busy"
        :sending="sending"
        :issues-for="issuesFor"
        @run="(action, drafts) => emit('run', action, drafts)"
      />
    </EvidenceSection>
    <EvidenceSection title="Planning usage" :summary="`${kickoff.usage.turns} turns`">
      <UsageSummary :providers="kickoff.usage.providers" :stages="kickoff.usage.stages" :note="kickoff.usage.note" />
    </EvidenceSection>
    <details class="rounded-xl border border-default bg-default p-4">
      <summary class="cursor-pointer text-sm font-medium text-toned">Manage conversation</summary>
      <div class="mt-4 flex flex-col gap-3">
        <ActionButton
          v-for="action in kickoff.actions.filter(item => item.id === 'reset' || item.id === 'delete')"
          :key="action.id"
          :action="action"
          :busy="busy"
          :sending="sending === action.id"
          show-description
          @run="emit('run', action, {})"
        />
      </div>
    </details>
  </aside>
</template>
