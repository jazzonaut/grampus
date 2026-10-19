<script setup lang="ts">
/**
 * TaskDetails: reference material on demand. Each section is collapsed and its content is created only
 * when first opened (EvidenceSection), so large evidence is never fetched unless asked for: the plan,
 * approval and artifact digests, retained changes, the timeline, the report, references, workspace and
 * repository exploration.
 *
 * Props:
 * - `task`: the server's `TaskDetailV1`.
 */
import { computed } from 'vue';
import type { TaskDetailV1 } from '../../../src/server/api-types';
import ChangesPanel from './ChangesPanel.vue';
import EvidenceSection from './EvidenceSection.vue';
import ExplorationSummary from './ExplorationSummary.vue';
import ReportPanel from './ReportPanel.vue';
import TimelinePanel from './TimelinePanel.vue';
import { formatCount, plural, short } from './format';

defineOptions({ name: 'TaskDetails' });

const props = defineProps<{ task: TaskDetailV1 }>();

const details = computed(() => props.task.details);
</script>

<template>
  <section aria-labelledby="task-details-heading" class="flex flex-col gap-2" data-panel="details">
    <h2 id="task-details-heading" class="text-base font-semibold text-highlighted">Details</h2>
    <EvidenceSection title="Timeline" :summary="plural(details.timeline.total, 'entry', 'entries')" default-open>
      <TimelinePanel :timeline="details.timeline" />
    </EvidenceSection>
    <EvidenceSection title="Approval and artifact" :summary="`Digest ${short(details.approval.digest)}`">
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="text-muted">Plan version</dt>
        <dd>{{ details.approval.version }} · {{ details.approval.approved ? 'approved' : 'not approved' }}</dd>
        <dt class="text-muted">Plan digest</dt>
        <dd class="font-mono text-xs break-all">{{ details.approval.digest }}</dd>
        <dt class="text-muted">Artifact</dt>
        <dd class="font-mono text-xs break-all">{{ details.artifact.artifact ?? 'None yet' }}</dd>
        <dt class="text-muted">Instructions digest</dt>
        <dd class="font-mono text-xs break-all">{{ details.artifact.instructionsDigest ?? 'None yet' }}</dd>
        <dt class="text-muted">Snapshot head</dt>
        <dd class="font-mono text-xs break-all">{{ details.artifact.head ?? 'None yet' }}</dd>
      </dl>
    </EvidenceSection>
    <EvidenceSection title="Retained changes" :summary="plural(details.changes.length, 'file')">
      <ChangesPanel :paths="details.changes" :changes-path="details.changesPath" />
    </EvidenceSection>
    <EvidenceSection title="Report" summary="Markdown from the journal">
      <ReportPanel :report-path="details.reportPath" :task-id="task.id" />
    </EvidenceSection>
    <EvidenceSection
      title="Workspace and delivery"
      :summary="details.workspace.adapter === 'orca' ? 'Orca worktree' : 'Git worktree'"
    >
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="text-muted">Workspace</dt>
        <dd class="font-mono text-xs break-all">{{ details.workspace.path ?? 'Not created yet' }}</dd>
        <dt class="text-muted">Agents</dt>
        <dd>{{ details.plan.implementer.label }} implements · {{ details.plan.reviewer.label }} reviews</dd>
        <dt class="text-muted">Delivery</dt>
        <dd>Local only: verified commits in the task workspace; nothing is pushed.</dd>
      </dl>
    </EvidenceSection>
    <EvidenceSection
      v-if="details.references.length"
      title="Read-only references"
      :summary="plural(details.references.length, 'folder')"
    >
      <ul class="flex flex-col gap-2 text-sm">
        <li v-for="reference in details.references" :key="reference.path">
          <p class="font-medium">{{ reference.label }}</p>
          <p class="font-mono text-xs break-all">{{ reference.path }}</p>
          <p class="text-xs text-muted">
            {{ formatCount(reference.files) }} files ·
            {{ reference.base ? short(reference.base) : 'Captured folder inventory' }}
          </p>
        </li>
      </ul>
    </EvidenceSection>
    <EvidenceSection title="Repository exploration" :summary="plural(details.exploration.calls, 'call')">
      <ExplorationSummary :exploration="details.exploration" :integrations="task.integrations" />
    </EvidenceSection>
  </section>
</template>
