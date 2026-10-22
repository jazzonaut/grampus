<!--
  One comparison: its entries side by side with time, tokens, estimated cost, your effort and quality,
  charts of the same, the cross-check matrix, and the pick.
-->
<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables';
import { computed, onScopeDispose, ref, watch } from 'vue';
import type { ComparisonDetail, ComparisonMetrics, EntryMetrics } from '../../../src/dashboard/types';
import { getJson, sendJson } from '../api/client';
import CrossCheckMatrix from '../components/CrossCheckMatrix.vue';
import StatusIcon from '../components/StatusIcon.vue';
import TextPrompt from '../components/TextPrompt.vue';
import { useLive } from '../composables/useLive';
import { comparisonStatusLook, count, duration, money, shortSha, statusLook } from '../presentation';

const props = defineProps<{ id: string }>();
const toast = useToast();

const detail = ref<ComparisonDetail | null>(null);
const metrics = ref<ComparisonMetrics | null>(null);
const error = ref<string | null>(null);
const measuring = ref(false);
const abandoning = ref(false);

async function load(): Promise<void> {
  try {
    detail.value = await getJson<ComparisonDetail>(`/api/comparisons/${encodeURIComponent(props.id)}`);
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  }
}

async function measure(): Promise<void> {
  measuring.value = true;
  try {
    metrics.value = await getJson<ComparisonMetrics>(`/api/comparisons/${encodeURIComponent(props.id)}/metrics`);
  } catch (failure) {
    toast.add({ title: 'Could not measure', description: (failure as Error).message, color: 'error' });
  } finally {
    measuring.value = false;
  }
}

watch(
  () => props.id,
  () => {
    detail.value = null;
    metrics.value = null;
    void load().then(measure);
  },
  { immediate: true },
);

// Reload on any change to the comparison or its entries; measure again when an entry reaches its result.
const stop = useLive().onChange(changed => {
  const entryIds = detail.value?.entryViews.map(entry => entry.task.taskId) ?? [];
  if (changed === null || changed.includes(`cmp:${props.id}`) || changed.some(id => entryIds.includes(id))) void load();
});
onScopeDispose(stop);
watch(
  () => detail.value?.entryViews.filter(entry => entry.done).length,
  (now, before) => {
    if (before !== undefined && now !== before) void measure();
  },
);

const metricsOf = computed(() => new Map((metrics.value?.entries ?? []).map(entry => [entry.taskId, entry])));

async function send(body: unknown, success: string): Promise<void> {
  try {
    await sendJson('POST', `/api/comparisons/${encodeURIComponent(props.id)}/commands`, body);
    toast.add({
      title: success,
      description: 'The comparison driver applies it within a few seconds.',
      color: 'success',
      icon: 'i-lucide-send',
    });
  } catch (failure) {
    toast.add({
      title: 'Not queued',
      description: (failure as Error).message,
      color: 'error',
      icon: 'i-lucide-circle-x',
    });
  }
}

/** Rows for one chart: entries with a known value only, so unknown never draws as zero. */
function rows(pick: (entry: EntryMetrics) => number | null): { recipe: string; value: number }[] {
  return (metrics.value?.entries ?? []).flatMap(entry => {
    const value = pick(entry);
    return value === null ? [] : [{ recipe: entry.recipe, value }];
  });
}
/** Charts in minutes from two minutes up, in seconds below, so short runs still show. */
const minuteThresholdMs = 2 * 60_000;

function timeChart(title: string, pick: (entry: EntryMetrics) => number | null) {
  const known = rows(pick);
  const minutes = Math.max(0, ...known.map(row => row.value)) >= minuteThresholdMs;
  const size = minutes ? 60_000 : 1000;
  const unit = minutes ? 'min' : 's';
  return {
    title,
    data: known.map(row => ({ recipe: row.recipe, value: Math.round((row.value / size) * 10) / 10 })),
    format: (value: number) => `${value} ${unit}`,
  };
}

const charts = computed(() => [
  timeChart('Time to result', entry => entry.resultMs),
  timeChart('Agent working time', entry => entry.agentMs),
  { title: 'Estimated cost', data: rows(entry => entry.costUsd), format: (v: number) => money(v) },
  {
    title: 'Tokens (thousands, incl. cached)',
    data: rows(entry =>
      entry.usage
        ? Math.round((entry.usage.input + entry.usage.cachedInput + entry.usage.cacheWrite + entry.usage.output) / 1000)
        : null,
    ),
    format: (v: number) => `${v.toLocaleString('en-GB')}k`,
  },
]);
</script>

<template>
  <UDashboardPanel id="comparison" class="min-w-0">
    <template #header>
      <UDashboardNavbar :title="detail?.title ?? 'Loading...'" :toggle="false">
        <template #leading>
          <UButton
            to="/comparisons"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            aria-label="Back to comparisons"
          />
        </template>
        <template #right>
          <UBadge v-if="detail" :color="comparisonStatusLook[detail.status].color" variant="subtle" class="gap-1.5">
            <StatusIcon :look="comparisonStatusLook[detail.status]" size="size-3.5" />
            <span class="max-sm:hidden">{{ comparisonStatusLook[detail.status].label }}</span>
          </UBadge>
          <UButton
            v-if="detail && !detail.winner && detail.status !== 'abandoned'"
            color="error"
            variant="ghost"
            icon="i-lucide-trash-2"
            aria-label="Abandon comparison"
            @click="abandoning = true"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <USkeleton v-else-if="!detail" class="h-40 w-full" />
      <div v-else class="max-w-6xl space-y-6">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span class="inline-flex items-center gap-1.5"
            ><UIcon name="i-lucide-folder-git-2" class="size-4" />{{ detail.repository.name }}</span
          >
          <span class="inline-flex items-center gap-1.5"
            ><UIcon name="i-lucide-git-compare-arrows" class="size-4" />{{ detail.mode }} mode</span
          >
          <span v-if="detail.baseSha" class="font-mono text-xs">base {{ shortSha(detail.baseSha) }}</span>
          <span class="inline-flex items-center gap-1.5"
            ><UIcon name="i-lucide-layers" class="size-4" />{{ detail.concurrency }} at a time</span
          >
        </div>

        <UAlert
          v-if="detail.lastStop"
          color="error"
          variant="subtle"
          icon="i-lucide-octagon-pause"
          title="The comparison driver stopped"
          :description="`${detail.lastStop.reason.split('\n')[0]} Run grampus drive-comparison ${detail.comparisonId} in its Orca terminal to resume.`"
        />
        <div v-if="detail.needsYou" class="rounded-xl border border-warning/50 bg-warning/5 p-4 flex gap-3">
          <UIcon name="i-lucide-trophy" class="size-5 text-warning shrink-0 mt-0.5" />
          <div class="space-y-1">
            <h3 class="font-semibold text-highlighted">Pick the result to keep</h3>
            <p class="text-sm text-muted">{{ detail.needsYou.detail }}</p>
          </div>
        </div>
        <p v-if="detail.waiting.length" class="text-sm text-muted flex items-center gap-1.5">
          <UIcon name="i-lucide-hourglass" class="size-4" />
          Not started yet: {{ detail.waiting.join(', ') }}
          {{
            detail.mode === 'shared' && !detail.sharedSpec
              ? '(waiting for the shared spec)'
              : '(waiting for a free place)'
          }}
        </p>

        <section class="space-y-2">
          <div class="flex items-center gap-2">
            <h2 class="text-lg font-semibold">Side by side</h2>
            <UBadge v-if="metrics?.entries.some(entry => entry.provisional)" color="warning" variant="subtle" size="sm"
              >provisional</UBadge
            >
            <UButton
              class="ml-auto"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-refresh-cw"
              :loading="measuring"
              label="Measure again"
              @click="measure"
            />
          </div>
          <div class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-sm">
              <thead class="bg-elevated/50 text-xs text-muted">
                <tr>
                  <th class="px-3 py-2 text-left font-medium">Recipe</th>
                  <th class="px-3 py-2 text-left font-medium">Status</th>
                  <th class="px-3 py-2 text-right font-medium">Checks</th>
                  <th class="px-3 py-2 text-left font-medium">Review</th>
                  <th v-if="detail.mode === 'full'" class="px-3 py-2 text-right font-medium">Others' specs</th>
                  <th class="px-3 py-2 text-right font-medium">Rounds</th>
                  <th class="px-3 py-2 text-right font-medium">To result</th>
                  <th class="px-3 py-2 text-right font-medium">Agent time</th>
                  <th class="px-3 py-2 text-right font-medium">Output tokens</th>
                  <th class="px-3 py-2 text-right font-medium">Est. cost</th>
                  <th class="px-3 py-2 text-right font-medium">Your decisions</th>
                  <th class="px-3 py-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr
                  v-for="entry in detail.entryViews"
                  :key="entry.task.taskId"
                  :class="detail.winner === entry.task.taskId ? 'bg-success/10' : ''"
                >
                  <td class="px-3 py-2">
                    <RouterLink
                      :to="`/tasks/${entry.task.taskId}`"
                      class="font-medium hover:underline inline-flex items-center gap-1.5"
                    >
                      <UIcon
                        v-if="detail.winner === entry.task.taskId"
                        name="i-lucide-trophy"
                        class="size-4 text-success"
                      />
                      {{ entry.recipe }}
                    </RouterLink>
                  </td>
                  <td class="px-3 py-2">
                    <span class="inline-flex items-center gap-1.5">
                      <StatusIcon :look="statusLook[entry.task.status]" size="size-4" />
                      <span class="truncate max-w-40" :title="entry.task.phase">{{
                        statusLook[entry.task.status].label
                      }}</span>
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ entry.checks ? `${entry.checks.passed}/${entry.checks.total}` : '-' }}
                  </td>
                  <td class="px-3 py-2">{{ entry.review ?? '-' }}</td>
                  <td v-if="detail.mode === 'full'" class="px-3 py-2 text-right tabular-nums">
                    {{
                      metricsOf.get(entry.task.taskId)?.crossCheck
                        ? `${metricsOf.get(entry.task.taskId)?.crossCheck?.passed}/${metricsOf.get(entry.task.taskId)?.crossCheck?.total}`
                        : '-'
                    }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">{{ entry.rounds }}</td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ duration(metricsOf.get(entry.task.taskId)?.resultMs) }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ metrics ? duration(metricsOf.get(entry.task.taskId)?.agentMs) : '…' }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ metrics ? count(metricsOf.get(entry.task.taskId)?.usage?.output) : '…' }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ metrics ? money(metricsOf.get(entry.task.taskId)?.costUsd) : '…' }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{
                      metricsOf.get(entry.task.taskId)
                        ? (metricsOf.get(entry.task.taskId)?.decisions ?? 0) +
                          (metricsOf.get(entry.task.taskId)?.answers ?? 0)
                        : '…'
                    }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    <UButton
                      v-if="entry.pickable"
                      size="xs"
                      icon="i-lucide-trophy"
                      label="Keep this one"
                      @click="send({ kind: 'pick', taskId: entry.task.taskId }, `Keeping ${entry.recipe}`)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="text-xs text-muted">
            "To result" runs from an entry's start to the result you decide on, so entries that waited for a free place
            are not penalised. Cost is estimated at API list prices; unknown values show as "?", never as zero.
            <template v-if="detail.mode === 'shared'"
              >The shared spec phase ran in the first entry and is counted there.</template
            >
          </p>
        </section>

        <section v-if="metrics && metrics.entries.length > 1" class="grid gap-4 md:grid-cols-2">
          <UCard v-for="chart in charts" :key="chart.title">
            <template #header>
              <h3 class="text-sm font-semibold">{{ chart.title }}</h3>
            </template>
            <UChart
              v-if="chart.data.length"
              type="bar"
              :data="chart.data"
              index="recipe"
              :categories="[{ key: 'value', name: chart.title }]"
              :format="chart.format"
              :height="180"
              :y-axis="false"
              :aria-label="chart.title"
            />
            <p v-else class="text-sm text-muted">Not known yet.</p>
          </UCard>
        </section>

        <section v-if="detail.mode === 'full'" class="space-y-2">
          <h2 class="text-lg font-semibold">Cross-check</h2>
          <p class="text-sm text-muted">
            Each recipe wrote its own spec. Here every spec's checks, with its acceptance tests, ran against every
            result, so a lax spec cannot make its own recipe look good.
          </p>
          <CrossCheckMatrix v-if="detail.crossCheck" :cells="detail.crossCheck" :entries="detail.entryViews" />
          <p v-else class="text-sm text-muted">Runs when every entry has finished its rounds.</p>
        </section>

        <UCard>
          <template #header>
            <h3 class="text-sm font-semibold">Request</h3>
          </template>
          <p class="text-sm whitespace-pre-line">{{ detail.request }}</p>
        </UCard>
      </div>

      <TextPrompt
        v-model:open="abandoning"
        title="Abandon this comparison"
        description="Every entry still running is abandoned and its workers released. Measurements are kept."
        placeholder="Why? (optional)"
        confirm="Abandon comparison"
        optional
        color="error"
        @submit="reason => send(reason ? { kind: 'abandon', reason } : { kind: 'abandon' }, 'Abandon queued')"
      />
    </template>
  </UDashboardPanel>
</template>
