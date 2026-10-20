<script setup lang="ts">
// Owns comparison presentation and explicit actions, including the separately inspected integration.
import { ref } from 'vue';
import type { ActionView, ComparisonV1, IntegrationPreviewV1 } from '../../../src/server/api-types';
import { get, request } from '../api/client';
import { usePolled } from '../api/usePolled';
import { pollIntervalMs } from '../settings';
import ActionButton from '../components/ActionButton.vue';
import PlanCard from '../components/PlanCard.vue';
import RunExports from '../components/RunExports.vue';
import RunMetricsPanel from '../components/RunMetricsPanel.vue';
import { formatDuration, formatTokens } from '../components/format';
const props = defineProps<{ id: string }>();
const group = usePolled(() => get<ComparisonV1>(`/api/v1/comparisons/${props.id}`), pollIntervalMs);
const busy = ref(false),
  error = ref('');
const preview = ref<IntegrationPreviewV1 | null>(null);
async function run(action: ActionView): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = await request<unknown>(action.request.method, action.request.path, action.request.body);
    if (action.id === 'comparison-preview') preview.value = result as IntegrationPreviewV1;
    else preview.value = null;
    await group.refresh();
  } catch (caught) {
    error.value = String(caught);
    await group.refresh();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grampus-page">
    <a href="#/comparisons" class="grampus-link">← Comparisons</a>
    <p v-if="error || group.error.value" role="alert" class="text-error">{{ error || group.error.value?.message }}</p>
    <template v-if="group.data.value">
      <h1 class="text-3xl font-semibold">{{ group.data.value.name }}</h1>
      <p>{{ group.data.value.status }} · {{ group.data.value.note }}</p>
      <div class="flex flex-wrap gap-3">
        <ActionButton
          v-for="action in group.data.value.actions"
          :key="action.id"
          :action="action"
          :busy="busy"
          @run="run(action)"
        />
      </div>
      <section v-if="preview" class="grampus-surface">
        <h2 class="font-semibold">Integration target</h2>
        <p class="my-3 break-all">{{ preview.action.description }}</p>
        <ActionButton :action="preview.action" :busy="busy" @run="run(preview.action)" />
      </section>
      <p v-if="group.data.value.integration">
        Integration: {{ group.data.value.integration.phase }} {{ group.data.value.integration.error }}
      </p>
      <RunExports :path="`/api/comparisons/${id}/export`" :name="`grampus-comparison-${id}`" />
      <div class="overflow-auto grampus-surface">
        <table class="w-full text-left text-sm">
          <thead>
            <tr>
              <th class="p-2">Profile</th>
              <th class="p-2">Outcome</th>
              <th class="p-2">Agent time</th>
              <th class="p-2">Tokens</th>
              <th class="p-2">Repairs</th>
              <th class="p-2">Interventions</th>
              <th class="p-2">Preference</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in group.data.value.runs" :key="item.taskId" class="border-t border-default">
              <td class="p-2">
                <a :href="`#/tasks/${item.taskId}`" class="grampus-link">{{ item.profile.name }}</a>
              </td>
              <td class="p-2">
                {{ item.metrics.status }}{{ item.matchesApprovedConfiguration ? '' : ' (configuration changed)' }}
              </td>
              <td class="p-2">
                {{ item.metrics.agentMs === null ? 'Unknown' : formatDuration(item.metrics.agentMs) }}
              </td>
              <td class="p-2">
                {{ formatTokens(item.metrics.usage.headline.tokens) }} · {{ item.metrics.usage.headline.completeness }}
              </td>
              <td class="p-2">{{ item.metrics.repairAttempts }}</td>
              <td class="p-2">{{ item.metrics.interventions.total }}</td>
              <td class="p-2">
                <span v-if="item.preferred">Preferred</span
                ><ActionButton v-else :action="item.select" :busy="busy" @run="run(item.select)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="group.data.value.sharedPlanning" class="text-sm text-muted">
        Shared planning: {{ group.data.value.sharedPlanning.turns }} turns ·
        {{ formatTokens(group.data.value.sharedPlanning.headline.tokens) }} tokens, counted once.
      </p>
      <p v-for="note in group.data.value.notes" :key="note" class="text-sm text-muted">{{ note }}</p>
      <details class="grampus-surface">
        <summary class="cursor-pointer font-semibold">Shared plan and acceptance checks</summary>
        <PlanCard :plan="group.data.value.plan" />
      </details>
      <details v-for="item in group.data.value.runs" :key="item.taskId" class="grampus-surface">
        <summary class="cursor-pointer font-semibold">{{ item.profile.name }}: assignments and metrics</summary>
        <dl class="my-3 grid grid-cols-[auto_1fr] gap-2 text-sm">
          <template v-for="assignment in item.assignments" :key="assignment.role"
            ><dt>{{ assignment.role }}</dt>
            <dd>
              {{ assignment.provider }} · {{ assignment.model ?? 'Provider default' }} ·
              {{ assignment.effort ?? 'Default effort' }}
            </dd></template
          >
        </dl>
        <RunMetricsPanel :metrics="item.metrics" />
        <RunExports :path="`/api/tasks/${item.taskId}/export`" :name="`grampus-${item.taskId}`" />
      </details>
    </template>
  </div>
</template>
