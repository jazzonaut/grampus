<script setup lang="ts">
/**
 * ReportPanel: the task report built from the journal: loaded on request and rendered as sanitised
 * Markdown, or downloaded as a Markdown file.
 *
 * Props:
 * - `reportPath`: `DetailsV1.reportPath`.
 * - `taskId`: names the downloaded file.
 */
import { ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import { ApiError } from '../api/client';
import { downloadReport, fetchReport } from '../api/report';
import MarkdownView from './MarkdownView.vue';

defineOptions({ name: 'ReportPanel' });

const props = defineProps<{ reportPath: string; taskId: string }>();

const report = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

async function attempt(work: () => Promise<void>): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await work();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

const load = () =>
  attempt(async () => {
    report.value = await fetchReport(props.reportPath);
  });
const download = () => attempt(() => downloadReport(props.reportPath, props.taskId));
</script>

<template>
  <div class="flex flex-col gap-2" data-panel="report">
    <div class="flex flex-wrap gap-2">
      <UButton label="Load report" size="sm" color="neutral" variant="outline" :loading="loading" @click="load" />
      <UButton
        label="Download Markdown"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-download"
        @click="download"
      />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <div
      v-if="report !== null"
      class="max-h-[32rem] overflow-auto rounded-md border border-default p-3 text-sm"
      tabindex="0"
      role="region"
      aria-label="Task report"
    >
      <MarkdownView :source="report" />
    </div>
  </div>
</template>
