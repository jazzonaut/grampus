<!-- Spec versions: the text the user approves, its checks and protected paths, and its review. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SpecView } from '../../../src/dashboard/types';
import { when } from '../presentation';
import FindingList from './FindingList.vue';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ specs: SpecView[] }>();

const version = ref<number | undefined>(undefined);
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
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <UCard>
        <MarkdownView v-if="spec.text !== null" :source="spec.text" />
        <UAlert v-else color="warning" variant="subtle" :title="`The spec file ${spec.path} is missing.`" />
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
              <code class="block font-mono text-xs text-muted break-all">{{ check.command }}</code>
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
            <p class="text-sm">{{ spec.review.report.summary }}</p>
            <FindingList :findings="spec.review.report.findings" />
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
