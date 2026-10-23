<!-- Spec versions: the text the user approves, its checks and protected paths, and its review. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SpecView } from '../../../src/dashboard/types';
import { when } from '../presentation';
import ReviewBrief from './ReviewBrief.vue';
import ChangeNote from './ChangeNote.vue';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ specs: SpecView[] }>();

const version = ref<number | undefined>(undefined);
const fullSpec = ref(false);
watch(version, () => {
  fullSpec.value = false;
});
let previousLatest: number | undefined;
watch(
  () => props.specs.at(-1)?.version,
  latest => {
    // Follow new versions unless the user picked an older one.
    if (version.value === undefined || version.value === previousLatest) version.value = latest;
    previousLatest = latest;
  },
  { immediate: true },
);
const spec = computed(() => props.specs.find(item => item.version === version.value) ?? props.specs.at(-1));
const versions = computed(() =>
  props.specs.map(item => ({ label: `v${item.version}${item.approved ? ' (approved)' : ''}`, value: item.version })),
);
const verdictColor = { approve: 'success', changes: 'warning', unknown: 'neutral' } as const;
</script>

<template>
  <UEmpty
    v-if="!spec"
    icon="i-lucide-file-pen"
    title="No spec yet"
    description="The spec writer is still investigating, or waiting for your answer."
  />
  <div v-else class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <USelect v-if="specs.length > 1" v-model="version" :items="versions" class="w-44" />
      <UBadge v-if="spec.approved" color="success" variant="subtle" icon="i-lucide-stamp">Approved</UBadge>
      <span class="text-sm text-muted">Version {{ spec.version }}, {{ when(spec.at) }}</span>
      <span class="font-mono text-xs text-dimmed">sha256 {{ spec.hash.slice(0, 12) }}</span>
      <UButton color="neutral" variant="outline" size="sm" :aria-expanded="fullSpec" @click="fullSpec = !fullSpec">{{
        fullSpec ? 'Show overview' : 'Read full spec'
      }}</UButton>
    </div>

    <p class="text-xs text-muted">
      Approval applies to the complete spec. Expand requirements for exact conditions, or read the full spec before
      deciding.
    </p>
    <div class="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_20rem]">
      <UCard class="min-w-0">
        <UAlert
          v-if="spec.text === null"
          color="warning"
          variant="subtle"
          :title="`The spec file ${spec.path} is missing.`"
        />
        <MarkdownView v-else-if="fullSpec" :source="spec.text" />
        <div v-else class="space-y-5">
          <section>
            <h3 class="font-semibold mb-2">Outcome</h3>
            <ChangeNote v-if="spec.outcome" :source="spec.outcome" />
            <p v-else class="text-sm text-muted">No outcome section. Read the full spec.</p>
          </section>
          <section v-if="spec.outOfScope">
            <h3 class="font-semibold mb-2">Out of scope</h3>
            <ChangeNote :source="spec.outOfScope" />
          </section>
          <section class="space-y-2">
            <h3 class="font-semibold">
              Requirements <span class="font-normal text-muted">{{ spec.acceptance.length }}</span>
            </h3>
            <details v-for="item in spec.acceptance" :key="item.id" class="rounded-lg border border-default p-3">
              <summary class="cursor-pointer text-sm font-medium">
                {{ item.id.replaceAll('-', ' ')
                }}<span v-if="item.limitations.length" class="ml-2 text-xs text-warning"
                  >{{ item.limitations.length }} caveat{{ item.limitations.length === 1 ? '' : 's' }}</span
                >
              </summary>
              <div class="mt-3 space-y-3 text-sm break-words">
                <p>{{ item.request }}</p>
                <p><strong>Expected behaviour:</strong> {{ item.scenario }}</p>
                <p><strong>Checks:</strong> {{ item.checks.join(', ') }}</p>
                <p><strong>Real components:</strong> {{ item.realComponents.join(', ') }}</p>
                <p v-if="item.mockedComponents.length">
                  <strong>Mocked:</strong> {{ item.mockedComponents.join(', ') }}
                </p>
                <ul v-if="item.limitations.length" class="space-y-1 text-warning">
                  <li v-for="limitation in item.limitations" :key="limitation">{{ limitation }}</li>
                </ul>
              </div>
            </details>
          </section>
          <UButton color="neutral" variant="link" class="px-0" @click="fullSpec = true"
            >Read full spec, examples and implementation guidance</UButton
          >
        </div>
      </UCard>

      <div class="space-y-4">
        <UCard>
          <template #header>
            <h3 class="font-semibold flex items-center gap-2">
              <UIcon name="i-lucide-list-checks" class="size-4" /> Checks
            </h3>
          </template>
          <ul class="space-y-2">
            <li v-for="check in spec.checks" :key="check.name">
              <p class="text-sm font-medium">{{ check.name }}</p>
              <details class="text-xs text-muted">
                <summary class="cursor-pointer">Command</summary>
                <code class="block font-mono break-all mt-1">{{ check.command }}</code>
              </details>
            </li>
          </ul>
          <template v-if="spec.protected.length">
            <h4 class="mt-4 mb-1 text-sm font-medium flex items-center gap-1.5">
              <UIcon name="i-lucide-lock" class="size-3.5" /> Protected paths
            </h4>
            <ul class="font-mono text-xs text-muted space-y-0.5">
              <li v-for="path in spec.protected" :key="path">{{ path }}</li>
            </ul>
          </template>
        </UCard>

        <UCard>
          <template #header>
            <h3 class="font-semibold flex items-center gap-2">
              <UIcon name="i-lucide-file-search" class="size-4" /> Spec review
            </h3>
          </template>
          <p v-if="spec.review.state === 'none'" class="text-sm text-muted">This recipe has no spec review.</p>
          <p v-else-if="spec.review.state === 'running'" class="text-sm text-muted flex items-center gap-2">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" /> Reviewing. Findings appear
            here when it finishes.
          </p>
          <UAlert
            v-else-if="spec.review.state === 'unavailable'"
            color="warning"
            variant="subtle"
            :title="`Review unavailable: ${spec.review.error ?? 'unknown'}`"
          />
          <div v-else-if="spec.review.report" class="space-y-3">
            <div class="flex items-center gap-2">
              <UBadge :color="verdictColor[spec.review.report.verdict]" variant="subtle">{{
                spec.review.report.verdict
              }}</UBadge>
            </div>
            <ReviewBrief :report="spec.review.report" />
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
