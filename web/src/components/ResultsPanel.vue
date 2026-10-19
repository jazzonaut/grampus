<script setup lang="ts">
/**
 * ResultsPanel: a task's results so far (`ResultsV1`): open problems, criteria coverage, checks with
 * paged output, review findings, quality lens assessments, edit passes and local commits. Every result
 * says who established it.
 *
 * Props:
 * - `results`: the server's `ResultsV1`.
 */
import { useId } from 'vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { ResultsV1 } from '../../../src/server/api-types';
import { evidenceLabels, stagePresentation } from '../theme/status';
import CheckItem from './CheckItem.vue';
import FindingList from './FindingList.vue';
import MarkdownView from './MarkdownView.vue';
import { short } from './format';

defineOptions({ name: 'ResultsPanel' });

defineProps<{ results: ResultsV1 }>();

const headingId = useId();

const outcomes = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' } as const;
</script>

<template>
  <section :aria-labelledby="headingId" class="grampus-surface flex flex-col gap-5" data-panel="results">
    <h2 :id="headingId" class="text-base font-semibold text-highlighted">Results</h2>
    <div v-if="results.unresolved.length" class="flex flex-col gap-1" data-unresolved>
      <h3 class="text-sm font-semibold text-highlighted">Unresolved</h3>
      <ul class="list-disc pl-5 text-sm">
        <li v-for="item in results.unresolved" :key="item">{{ item }}</li>
      </ul>
    </div>
    <div class="flex flex-col gap-1">
      <h3 class="text-sm font-semibold text-highlighted">Acceptance criteria</h3>
      <ul class="flex flex-col gap-1 text-sm">
        <li
          v-for="criterion in results.criteria"
          :key="criterion.text"
          class="flex items-start gap-2"
          :data-state="criterion.state"
        >
          <UIcon :name="stagePresentation[criterion.state].icon" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <MarkdownView :source="criterion.text" inline />
            <span class="block text-xs text-muted">
              {{ stagePresentation[criterion.state].label
              }}<template v-if="criterion.evidence"> · {{ evidenceLabels[criterion.evidence] }}</template>
            </span>
          </span>
        </li>
      </ul>
    </div>
    <div class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold text-highlighted">Checks</h3>
      <CheckItem v-for="check in results.checks" :key="check.id" :check="check" />
      <p v-if="!results.checks.length" class="text-sm text-muted">No checks have run for this slice yet.</p>
    </div>
    <div v-if="results.findings.length" class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold text-highlighted">{{ results.findingsTitle }}</h3>
      <FindingList :findings="results.findings" />
    </div>
    <div v-if="results.lenses.length" class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold text-highlighted">Quality lenses</h3>
      <div
        v-for="lens in results.lenses"
        :key="lens.id"
        class="border-l-2 border-default py-2 pl-4 text-sm"
        :data-lens="lens.id"
      >
        <p class="font-medium text-highlighted">
          {{ lens.title }}:
          {{
            lens.verdict === 'pass'
              ? 'reviewer passed it'
              : lens.verdict === 'fail'
                ? 'reviewer failed it'
                : 'not assessed yet'
          }}
          <span v-if="lens.verdict" class="text-xs font-normal text-muted">· agent reported</span>
        </p>
        <MarkdownView v-if="lens.summary" :source="lens.summary" class="text-toned" />
        <FindingList v-if="lens.findings.length" :findings="lens.findings" class="mt-2" />
        <p v-if="lens.recorded" class="mt-1 text-xs text-muted">
          Recorded: {{ outcomes[lens.recorded.outcome] }} · {{ evidenceLabels[lens.recorded.evidence] }}
        </p>
      </div>
    </div>
    <div v-if="results.qualityEdits.length" class="flex flex-col gap-1">
      <h3 class="text-sm font-semibold text-highlighted">Edit passes</h3>
      <ul class="list-disc pl-5 text-sm">
        <li v-for="edit in results.qualityEdits" :key="edit.id">
          {{ edit.title }}: {{ edit.changed ? 'changed the files' : 'no changes needed' }} (agent reported)
        </li>
      </ul>
    </div>
    <div class="flex flex-col gap-1">
      <h3 class="text-sm font-semibold text-highlighted">Local delivery</h3>
      <ul v-if="results.commits.length" class="flex flex-col gap-1 text-sm">
        <li v-for="commit in results.commits" :key="commit.slice">
          Slice {{ commit.slice }}:
          <template v-if="commit.commit"
            ><code class="font-mono text-xs">{{ short(commit.commit) }}</code> committed</template
          >
          <template v-else>verified with no change</template>
          · verified by Grampus
        </li>
      </ul>
      <p v-else class="text-sm text-muted">Nothing delivered yet. Delivery stays local.</p>
    </div>
  </section>
</template>
