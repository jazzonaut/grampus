<!-- One run of the spec's checks at one commit, with each check's log one click away. -->
<script setup lang="ts">
import { ref } from 'vue';
import type { CheckRunView } from '../../../src/dashboard/types';
import type { CheckResult } from '../../../src/domain/events';
import { getText } from '../api/client';
import { duration, shortSha, type Look } from '../presentation';
import StatusIcon from './StatusIcon.vue';

const props = defineProps<{ taskId: string; run: CheckRunView; title: string }>();

function look(result: CheckResult): Look {
  if (result.timedOut) return { icon: 'i-lucide-timer-off', color: 'error', label: 'Timed out' };
  if (!result.passed) return { icon: 'i-lucide-circle-x', color: 'error', label: 'Failed' };
  if (result.flaky) return { icon: 'i-lucide-circle-check', color: 'warning', label: 'Passed on rerun (flaky)' };
  return { icon: 'i-lucide-circle-check', color: 'success', label: 'Passed' };
}

const open = ref(false);
const log = ref<{ name: string; text: string } | null>(null);
const logError = ref<string | null>(null);

async function showLog(result: CheckResult): Promise<void> {
  open.value = true;
  log.value = { name: result.name, text: '' };
  logError.value = null;
  try {
    const path = encodeURIComponent(result.logPath);
    log.value = {
      name: result.name,
      text: await getText(`/api/tasks/${encodeURIComponent(props.taskId)}/file?path=${path}`),
    };
  } catch (failure) {
    logError.value = (failure as Error).message;
  }
}
</script>

<template>
  <div class="space-y-2">
    <h4 class="text-sm font-medium flex flex-wrap items-center gap-2">
      {{ title }}
      <span class="font-mono text-xs text-dimmed">at {{ shortSha(run.sha) }}</span>
      <UBadge variant="subtle" :color="run.results.every(result => result.passed) ? 'success' : 'error'" size="sm">
        {{ run.results.filter(result => result.passed).length }}/{{ run.results.length }} pass
      </UBadge>
    </h4>
    <ul class="divide-y divide-default rounded-lg border border-default">
      <li v-for="result in run.results" :key="result.name" class="flex items-center gap-3 px-3 py-2">
        <StatusIcon :look="look(result)" size="size-4" class="shrink-0" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">
            {{ result.name }}
            <UBadge v-if="result.flaky" color="warning" variant="subtle" size="sm" class="ml-1">flaky</UBadge>
            <UBadge v-if="result.timedOut" color="error" variant="subtle" size="sm" class="ml-1">timed out</UBadge>
          </p>
          <code class="block font-mono text-xs text-muted truncate" :title="result.command">{{ result.command }}</code>
        </div>
        <span class="text-xs text-dimmed shrink-0">{{ duration(result.durationMs) }}</span>
        <span class="text-xs text-dimmed shrink-0 max-sm:hidden">exit {{ result.exitCode ?? '?' }}</span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-scroll-text"
          aria-label="Show log"
          @click="showLog(result)"
        />
      </li>
    </ul>

    <USlideover v-model:open="open" :title="log ? `Log: ${log.name}` : 'Log'" :ui="{ content: 'sm:max-w-3xl' }">
      <template #body>
        <UAlert v-if="logError" color="error" variant="subtle" :title="logError" />
        <pre v-else class="text-xs whitespace-pre-wrap break-all font-mono">{{ log?.text || 'Loading...' }}</pre>
      </template>
    </USlideover>
  </div>
</template>
