<script setup lang="ts">
/**
 * PlanCard: a plan as it is, or will be, approved (`PlanView`): outcome, repository access, criteria,
 * approach, repository, base, workspace, agents, the workflow, review and quality policy sentences (server
 * text), quality passes with their instructions, preparation, a retained revision checkpoint and every
 * slice. Narrative text renders as Markdown; commands and paths stay literal.
 *
 * Props:
 * - `plan`: the server's `PlanView`.
 * - `heading`: e.g. "The proposed plan" or "Approved outcome and execution plan".
 */
import { useId } from 'vue';
import type { PlanView, ProviderView } from '../../../src/server/api-types';
import CommandDetails from './CommandDetails.vue';
import MarkdownView from './MarkdownView.vue';
import PlanSlice from './PlanSlice.vue';
import { formatCount, formatTimeout } from './format';

defineOptions({ name: 'PlanCard' });

withDefaults(defineProps<{ plan: PlanView; heading?: string }>(), { heading: 'The proposed plan' });

const headingId = useId();

const model = (agent: ProviderView): string => agent.model ?? 'provider default';
</script>

<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-3 text-sm" data-panel="plan">
    <h3 :id="headingId" class="text-base font-semibold text-highlighted">{{ heading }}: {{ plan.title }}</h3>
    <MarkdownView :source="plan.outcome" />
    <h4 class="font-semibold text-highlighted">Repository access</h4>
    <p class="text-toned">
      {{
        plan.context.exploration
          ? 'Agents can search and read repository files as needed.'
          : 'This plan uses selected context only.'
      }}
      {{ plan.context.files.length }} initial files out of {{ formatCount(plan.context.totalFiles) }}. Changes need the
      exact file permissions below. Review includes all changed files and repository instructions.
    </p>
    <pre v-if="plan.context.files.length" class="grampus-code">{{ plan.context.files.join('\n') }}</pre>
    <h4 class="font-semibold text-highlighted">Acceptance criteria</h4>
    <ul class="list-disc pl-5">
      <li v-for="criterion in plan.criteria" :key="criterion"><MarkdownView :source="criterion" inline /></li>
    </ul>
    <h4 class="font-semibold text-highlighted">Approach</h4>
    <MarkdownView :source="plan.approach" />
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt class="text-muted">Repository</dt>
      <dd class="font-mono text-xs break-all">{{ plan.repository.path }}</dd>
      <dt class="text-muted">Base commit</dt>
      <dd class="font-mono text-xs break-all">{{ plan.base }}</dd>
      <dt class="text-muted">Workspace</dt>
      <dd class="font-mono text-xs break-all">
        {{ plan.workspace.path ?? (plan.workspace.adapter === 'orca' ? 'Created through Orca' : 'Chosen at start') }}
      </dd>
      <dt class="text-muted">Agents</dt>
      <dd>
        {{ plan.implementer.label }} implements · {{ plan.reviewer.label }} reviews. Models:
        {{ model(plan.implementer) }} / {{ model(plan.reviewer) }}. No automatic agent time limit.
      </dd>
    </dl>
    <p class="text-toned" data-summary="workflow">{{ plan.workflowSummary }}</p>
    <p class="text-toned" data-summary="review">{{ plan.reviewSummary }}</p>
    <h4 class="font-semibold text-highlighted">Quality passes</h4>
    <p class="text-toned" data-summary="quality">{{ plan.qualitySummary }}</p>
    <ul v-if="plan.qualityPasses.length" class="flex flex-col gap-2">
      <li v-for="pass in plan.qualityPasses" :key="pass.id" class="rounded-md border border-default p-2">
        <p class="font-medium text-highlighted">
          {{ pass.title }}
          <span class="text-xs font-normal text-muted"
            >{{ pass.kind === 'lens' ? 'Review lens' : 'Edit pass' }} · {{ pass.id }}</span
          >
        </p>
        <MarkdownView :source="pass.instructions" class="text-toned" />
      </li>
    </ul>
    <template v-if="plan.preparation">
      <h4 class="font-semibold text-highlighted">Preparation before implementation and checks</h4>
      <p class="text-toned">
        {{ plan.preparation.name }} · {{ formatTimeout(plan.preparation.timeoutMs) }}. Runs in the task worktree and
        must leave repository inputs unchanged.
      </p>
      <CommandDetails :command="plan.preparation" />
    </template>
    <p v-if="plan.revision" class="text-toned">
      Retained workspace checkpoint from version {{ plan.revision.previousVersion }}:
      <code class="font-mono text-xs break-all">{{ plan.revision.artifact }}</code
      >. Earlier checks and reviews need to run again.
    </p>
    <h4 class="font-semibold text-highlighted">Slices ({{ plan.slices.length }})</h4>
    <PlanSlice v-for="(slice, index) in plan.slices" :key="index" :slice="slice" :index="index" />
  </section>
</template>
