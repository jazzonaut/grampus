<script setup lang="ts">
// Owns the task scorecard read, independent of full export payloads.
import type { RunMetricsV1 } from '../../../src/server/api-types';
import { get } from '../api/client';
import { usePolled } from '../api/usePolled';
import { pollIntervalMs } from '../settings';
import RunMetricsPanel from './RunMetricsPanel.vue';
import RunExports from './RunExports.vue';
const props = defineProps<{ id: string }>();
const metrics = usePolled(() => get<RunMetricsV1>(`/api/v1/tasks/${props.id}/metrics`), pollIntervalMs);
</script>

<template>
  <div class="flex flex-col gap-3">
    <RunMetricsPanel v-if="metrics.data.value" :metrics="metrics.data.value" />
    <p v-if="metrics.error.value" role="alert">{{ metrics.error.value.message }}</p>
    <RunExports :path="`/api/tasks/${id}/export`" :name="`grampus-${id}`" />
  </div>
</template>
