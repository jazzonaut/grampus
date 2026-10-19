<script setup lang="ts">
/**
 * FindingList: review findings, each with its severity in words, description and evidence. Agent text is
 * rendered as sanitised Markdown.
 *
 * Props:
 * - `findings`: the server's `FindingView`s.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { FindingView } from '../../../src/server/api-types';
import MarkdownView from './MarkdownView.vue';

defineOptions({ name: 'FindingList' });

defineProps<{ findings: readonly FindingView[] }>();
</script>

<template>
  <ul class="flex flex-col gap-2">
    <li
      v-for="(finding, index) in findings"
      :key="index"
      class="flex gap-2 rounded-md border border-default p-2 text-sm"
      :data-severity="finding.severity"
    >
      <UIcon
        :name="finding.severity === 'blocking' ? 'i-lucide-octagon-alert' : 'i-lucide-lightbulb'"
        :class="['mt-0.5 size-4 shrink-0', finding.severity === 'blocking' ? 'text-error' : 'text-info']"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-semibold tracking-wide uppercase">
          {{ finding.severity === 'blocking' ? 'Blocking' : 'Suggestion' }}
        </p>
        <MarkdownView :source="finding.description" />
        <div v-if="finding.evidence" class="mt-1 text-xs text-muted"><MarkdownView :source="finding.evidence" /></div>
      </div>
    </li>
  </ul>
</template>
