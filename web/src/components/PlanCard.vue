<script setup lang="ts">
/** Owns compact plan review: outcome and criteria first, expandable slices and technical details. */
import { useId } from 'vue';
import type { PlanView } from '../../../src/server/api-types';
import CommandDetails from './CommandDetails.vue';
import MarkdownView from './MarkdownView.vue';
import PlanSlice from './PlanSlice.vue';
import PlanPolicy from './PlanPolicy.vue';
import SectionHeading from './SectionHeading.vue';
import { formatCount, formatTimeout, plural, short } from './format';

defineOptions({ name: 'PlanCard' });
withDefaults(defineProps<{ plan: PlanView; heading?: string }>(), { heading: 'The proposed plan' });
const headingId = useId();
</script>

<template>
  <section :aria-labelledby="headingId" class="flex min-w-0 flex-col gap-5 text-sm" data-panel="plan">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 :id="headingId" class="text-lg font-semibold text-highlighted">{{ heading }}: {{ plan.title }}</h2>
      <span class="text-xs text-muted"
        >{{ plan.repository.name }} · <span class="font-mono" :title="plan.base">{{ short(plan.base) }}</span> ·
        {{ plural(plan.slices.length, 'slice') }}</span
      >
    </div>
    <div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div class="flex min-w-0 flex-col gap-5">
        <section class="grampus-surface">
          <SectionHeading title="Outcome, scope and assumptions" icon="i-lucide-target" />
          <MarkdownView :source="plan.outcome" class="text-toned" />
        </section>
        <section class="grampus-surface">
          <SectionHeading title="Acceptance criteria" icon="i-lucide-list-checks" />
          <p class="mb-3 text-xs text-muted">Execution evidence appears in the task's Results view.</p>
          <ol class="flex list-decimal flex-col gap-3 pl-5">
            <li v-for="criterion in plan.criteria" :key="criterion"><MarkdownView :source="criterion" inline /></li>
          </ol>
        </section>
        <section class="grampus-surface">
          <SectionHeading title="Slice plan" icon="i-lucide-list-ordered"
            ><span class="ml-auto text-xs text-muted">{{
              plural(plan.slices.length, 'sequential slice')
            }}</span></SectionHeading
          >
          <div class="divide-y divide-default">
            <PlanSlice v-for="(slice, index) in plan.slices" :key="index" :slice="slice" :index="index" />
          </div>
        </section>
      </div>
      <div class="flex min-w-0 flex-col gap-5">
        <section class="grampus-surface">
          <SectionHeading title="Implementation approach" icon="i-lucide-box" />
          <MarkdownView :source="plan.approach" class="text-toned" />
        </section>
        <PlanPolicy :plan="plan" />
      </div>
    </div>
    <div class="divide-y divide-default rounded-xl border border-default bg-default">
      <details v-if="plan.preparation" class="p-4">
        <summary class="cursor-pointer font-medium text-highlighted">
          Preparation before implementation and checks
          <span class="ml-2 text-xs font-normal text-muted"
            >{{ plan.preparation.name }} · {{ formatTimeout(plan.preparation.timeoutMs) }}</span
          >
        </summary>
        <p class="my-3 text-toned">Runs in the task worktree and must leave repository inputs unchanged.</p>
        <CommandDetails :command="plan.preparation" />
      </details>
      <details class="p-4">
        <summary class="cursor-pointer font-medium text-highlighted">File permissions and repository access</summary>
        <p class="my-3 text-toned">
          {{
            plan.context.exploration
              ? 'Agents can search and read repository files as needed.'
              : 'This plan uses selected context only.'
          }}
          {{ plan.context.files.length }} initial files out of {{ formatCount(plan.context.totalFiles) }}. Reading
          grants no permission to edit. Review includes all changed files and repository instructions.
        </p>
        <p class="mb-2 break-all font-mono text-xs">{{ plan.repository.path }}</p>
        <pre v-if="plan.context.files.length" class="grampus-code">{{ plan.context.files.join('\n') }}</pre>
        <div v-for="(slice, index) in plan.slices" :key="index" class="mt-4">
          <p class="mb-2 font-medium">Slice {{ index + 1 }} · {{ slice.title }}</p>
          <dl class="grid gap-2 sm:grid-cols-3">
            <template v-for="(paths, kind) in slice.files" :key="kind"
              ><div>
                <dt class="mb-1 text-xs text-muted">{{ kind }}</dt>
                <dd>
                  <pre class="grampus-code">{{ paths.join('\n') || '(none)' }}</pre>
                </dd>
              </div></template
            >
          </dl>
        </div>
      </details>
      <details class="p-4">
        <summary class="cursor-pointer font-medium text-highlighted">Exact commands and acceptance evidence</summary>
        <div v-for="(slice, index) in plan.slices" :key="index" class="mt-4 flex flex-col gap-2">
          <h3 class="font-semibold">Slice {{ index + 1 }} · {{ slice.title }}</h3>
          <div v-for="diagnostic in slice.diagnostics" :key="diagnostic.name">
            <CommandDetails :command="diagnostic" :summary="`Focused diagnostics: ${diagnostic.name}`" />
            <p class="text-xs text-muted">Approved selectable parameters and repository file suffixes</p>
            <pre class="grampus-code">{{ diagnostic.selection }}</pre>
          </div>
          <CommandDetails
            v-if="slice.formatting"
            :command="slice.formatting"
            :summary="`Automatic formatting: ${slice.formatting.name}`"
          />
          <CommandDetails
            v-if="slice.preparation"
            :command="slice.preparation"
            :summary="`Preparation: ${slice.preparation.name}`"
          />
          <CommandDetails
            v-for="check in slice.readiness"
            :key="check.kind"
            :command="check"
            :summary="`Readiness (${check.kind}): ${check.name}`"
          />
          <CommandDetails :command="slice.validation" :summary="`Validation: ${slice.validation.name}`" />
          <template v-for="(check, position) in slice.acceptance" :key="check.name">
            <CommandDetails
              :command="check"
              :summary="`Acceptance${slice.acceptance.length > 1 ? ` ${position + 1} of ${slice.acceptance.length}` : ''}: ${check.name}`"
            />
            <p v-if="check.expectedStdout !== null" class="text-xs text-muted">Exact expected stdout (JSON escaped)</p>
            <pre v-if="check.expectedStdout !== null" class="grampus-code" data-expected-stdout>{{
              JSON.stringify(check.expectedStdout)
            }}</pre>
            <pre v-if="check.expectations" class="grampus-code">{{ check.expectations }}</pre>
          </template>
        </div>
      </details>
      <details class="p-4">
        <summary class="cursor-pointer font-medium text-highlighted">Raw plan (JSON)</summary>
        <pre class="grampus-code mt-3 max-h-96">{{ plan.rawPlan }}</pre>
        <p class="mt-2 text-xs text-muted">Complete controller-normalised plan, covered by the approval digest.</p>
      </details>
    </div>
    <p v-if="plan.revision" class="text-toned">
      Retained workspace checkpoint from version {{ plan.revision.previousVersion }}:
      <code class="font-mono text-xs break-all">{{ plan.revision.artifact }}</code
      >. Earlier checks and reviews need to run again.
    </p>
  </section>
</template>
