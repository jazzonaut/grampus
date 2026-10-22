<!--
  System: whether Grampus can do its work. Every unfinished task's and comparison's driver, the workers
  still running, Orca, the agent providers' usage limits and recent Orca hiccups, with the problems first.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { HealthLevel, HealthView } from '../../../src/dashboard/types';
import StatusIcon from '../components/StatusIcon.vue';
import { useHealth } from '../composables/useHealth';
import { useNow } from '../composables/useNow';
import { ago, driverLook, duration, healthLook, hiccupLook, timeOfDay, workerLook, type Color } from '../presentation';

const { health, error, refresh } = useHealth();
const now = useNow();

const drivers = computed(() => {
  const order = { stopped: 0, starting: 1, alive: 2 } as const;
  return [...(health.value?.drivers ?? [])].sort((a, b) => order[a.state] - order[b.state]);
});
const hourMs = 3_600_000;
const history = computed(() => {
  const hours = Math.round((health.value?.historyMs ?? 0) / hourMs);
  return hours === 1 ? 'hour' : `${hours} hours`;
});
const alive = computed(() => drivers.value.filter(driver => driver.state === 'alive').length);

const barColor: Record<HealthLevel, string> = { ok: 'bg-primary', warning: 'bg-warning', error: 'bg-error' };

function money(extra: NonNullable<NonNullable<HealthView['providers']>[number]['extraUsage']>): string {
  const format = (value: number) =>
    extra.currency ? value.toLocaleString('en-GB', { style: 'currency', currency: extra.currency }) : value.toFixed(2);
  return extra.limit === null ? format(extra.spent) : `${format(extra.spent)} of ${format(extra.limit)}`;
}

const levelColor: Record<'warning' | 'error', Color> = { warning: 'warning', error: 'error' };
</script>

<template>
  <UDashboardPanel id="system">
    <template #header>
      <UDashboardNavbar title="System" icon="i-lucide-activity">
        <template #right>
          <span v-if="health" class="text-xs text-muted hidden sm:inline">
            Orca checked {{ ago(health.orca.checkedAt, now) }}
          </span>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            aria-label="Check again"
            @click="refresh()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-6xl space-y-6">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />

        <template v-if="health">
          <section class="space-y-2" aria-label="Problems">
            <UAlert
              v-if="!health.problems.length"
              color="success"
              variant="subtle"
              :icon="healthLook.ok.icon"
              title="Everything looks healthy"
              :description="`${alive} drivers running, Orca answering, no agent near its limit.`"
            />
            <UAlert
              v-for="problem in health.problems"
              :key="problem.id"
              :color="levelColor[problem.level]"
              variant="subtle"
              :icon="healthLook[problem.level].icon"
              :title="problem.title"
              :description="problem.detail ?? undefined"
              :actions="
                problem.link && problem.link !== '/system'
                  ? [{ label: 'Open', to: problem.link, color: 'neutral', variant: 'outline', size: 'xs' }]
                  : []
              "
            />
          </section>

          <section class="grid gap-3 md:grid-cols-3">
            <UCard>
              <div class="space-y-2">
                <p class="flex items-center gap-2 font-medium">
                  <StatusIcon :look="health.orca.ok ? healthLook.ok : healthLook.error" size="size-4" />
                  Orca
                </p>
                <p class="text-sm" :class="health.orca.ok ? 'text-muted' : 'text-error'">
                  {{ health.orca.ok ? `Answering, runtime ${health.orca.state ?? 'up'}` : health.orca.error }}
                </p>
                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt class="text-muted">Version</dt>
                  <dd class="font-mono text-xs self-center">{{ health.orca.version ?? '?' }}</dd>
                  <dt class="text-muted">Status took</dt>
                  <dd class="tabular-nums">
                    {{ health.orca.latencyMs === null ? '?' : `${health.orca.latencyMs} ms` }}
                  </dd>
                </dl>
              </div>
            </UCard>

            <UCard>
              <div class="space-y-2">
                <p class="flex items-center gap-2 font-medium">
                  <UIcon name="i-lucide-package" class="size-4 text-muted" /> Grampus
                </p>
                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt class="text-muted">Dashboard</dt>
                  <dd class="font-mono text-xs self-center break-all">
                    {{ health.grampus.dashboard ?? 'development checkout' }}
                  </dd>
                  <dt class="text-muted">Installed</dt>
                  <dd class="font-mono text-xs self-center break-all">{{ health.grampus.installed ?? '-' }}</dd>
                  <dt class="text-muted">Drivers</dt>
                  <dd>{{ alive }} running of {{ drivers.length }}</dd>
                </dl>
              </div>
            </UCard>

            <UCard>
              <div class="space-y-3">
                <p class="flex items-center gap-2 font-medium">
                  <UIcon name="i-lucide-bot" class="size-4 text-muted" /> Agents
                </p>
                <p v-if="health.providersError" class="text-sm text-warning">{{ health.providersError }}</p>
                <p v-else-if="!health.providers?.length" class="text-sm text-muted">Orca reports no agents.</p>
                <div v-for="provider in health.providers ?? []" :key="provider.provider" class="space-y-1.5">
                  <p class="flex items-center justify-between text-sm">
                    <span class="font-medium">{{ provider.provider }}</span>
                    <UBadge v-if="provider.status !== 'ok'" size="sm" color="error" variant="subtle">
                      {{ provider.status }}
                    </UBadge>
                    <span v-else-if="!provider.used" class="text-xs text-dimmed">not in a recipe</span>
                  </p>
                  <p v-if="provider.error" class="text-xs text-error">{{ provider.error }}</p>
                  <div v-for="window in provider.windows" :key="window.name" class="space-y-0.5">
                    <div class="flex justify-between text-xs text-muted">
                      <span>{{ window.name }}</span>
                      <span class="tabular-nums">
                        {{ window.usedPercent }}%<template v-if="window.resetDescription">
                          · resets {{ window.resetDescription }}</template
                        >
                      </span>
                    </div>
                    <div
                      class="h-1.5 rounded-full bg-elevated overflow-hidden"
                      role="meter"
                      :aria-label="`${provider.provider} ${window.name} usage`"
                      :aria-valuenow="window.usedPercent"
                      aria-valuemin="0"
                      aria-valuemax="100"
                    >
                      <div
                        class="h-full rounded-full"
                        :class="barColor[window.level]"
                        :style="{ width: `${Math.min(window.usedPercent, 100)}%` }"
                      />
                    </div>
                  </div>
                  <p v-if="provider.extraUsage" class="text-xs text-muted">
                    Extra usage: {{ money(provider.extraUsage) }}
                  </p>
                </div>
              </div>
            </UCard>
          </section>

          <section class="space-y-2">
            <h2 class="font-medium">Drivers</h2>
            <p class="text-sm text-muted">
              One per unfinished task or comparison. A driver proves it is alive by touching its lock file; one that
              stopped needs <code>grampus drive &lt;task&gt;</code> or Abandon.
            </p>
            <UEmpty v-if="!drivers.length" icon="i-lucide-activity" title="No unfinished tasks" />
            <div v-else class="overflow-x-auto rounded-lg border border-default">
              <table class="w-full text-sm">
                <thead class="bg-elevated/50 text-xs text-muted">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">Driver</th>
                    <th class="px-3 py-2 text-left font-medium">Task</th>
                    <th class="px-3 py-2 text-left font-medium">Where it stands</th>
                    <th class="px-3 py-2 text-left font-medium">Build</th>
                    <th class="px-3 py-2 text-right font-medium">Last seen</th>
                    <th class="px-3 py-2 text-right font-medium">Last event</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-default">
                  <tr v-for="driver in drivers" :key="driver.id" class="align-top">
                    <td class="px-3 py-2 whitespace-nowrap">
                      <span class="flex items-center gap-1.5">
                        <StatusIcon :look="driverLook[driver.state]" size="size-4" />
                        {{ driverLook[driver.state].label }}
                      </span>
                      <span v-if="driver.pid" class="text-xs text-dimmed">pid {{ driver.pid }}</span>
                    </td>
                    <td class="px-3 py-2 max-w-sm">
                      <RouterLink :to="driver.link" class="hover:underline line-clamp-2">
                        <UIcon
                          v-if="driver.kind === 'comparison'"
                          name="i-lucide-git-compare-arrows"
                          class="size-3.5 text-muted align-middle mr-1"
                        />{{ driver.title }}
                      </RouterLink>
                      <p v-if="driver.stop" class="text-xs text-error line-clamp-2 mt-0.5" :title="driver.stop.reason">
                        {{ driver.stop.reason }}
                      </p>
                      <p v-if="driver.busySince" class="text-xs text-warning mt-0.5">
                        Waiting for room in Orca since {{ timeOfDay(driver.busySince) }}
                      </p>
                    </td>
                    <td class="px-3 py-2 text-muted">{{ driver.phase }}</td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs">{{ driver.build ?? '-' }}</span>
                      <UBadge v-if="driver.outdated" size="sm" color="warning" variant="subtle" class="ml-1">
                        older
                      </UBadge>
                    </td>
                    <td class="px-3 py-2 text-right text-xs text-muted whitespace-nowrap">
                      {{ driver.heartbeatAt ? ago(driver.heartbeatAt, now) : '-' }}
                    </td>
                    <td class="px-3 py-2 text-right text-xs text-muted whitespace-nowrap">
                      {{ ago(driver.lastEventAt, now) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="space-y-2">
            <h2 class="font-medium">Workers</h2>
            <UEmpty
              v-if="!health.workers.length"
              icon="i-lucide-bot"
              title="No workers running"
              description="Workers appear here from when Grampus starts them until they report."
            />
            <div v-else class="overflow-x-auto rounded-lg border border-default">
              <table class="w-full text-sm">
                <thead class="bg-elevated/50 text-xs text-muted">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">State</th>
                    <th class="px-3 py-2 text-left font-medium">Task</th>
                    <th class="px-3 py-2 text-left font-medium">Stage</th>
                    <th class="px-3 py-2 text-left font-medium">Agent</th>
                    <th class="px-3 py-2 text-right font-medium">Running for</th>
                    <th class="px-3 py-2 text-right font-medium">Last heard</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-default">
                  <tr v-for="worker in health.workers" :key="worker.dispatchId">
                    <td class="px-3 py-2 whitespace-nowrap">
                      <span class="flex items-center gap-1.5">
                        <StatusIcon :look="workerLook[worker.state]" size="size-4" />
                        {{ workerLook[worker.state].label }}
                      </span>
                    </td>
                    <td class="px-3 py-2 max-w-sm">
                      <RouterLink :to="`/tasks/${worker.taskId}`" class="hover:underline line-clamp-2">
                        {{ worker.title }}
                      </RouterLink>
                    </td>
                    <td class="px-3 py-2 font-mono text-xs">{{ worker.stageKey }}</td>
                    <td class="px-3 py-2">
                      {{ worker.agent ?? '?' }}
                      <span class="font-mono text-xs text-muted">{{
                        [worker.model, worker.effort].filter(Boolean).join(' ')
                      }}</span>
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      {{ duration(now - Date.parse(worker.startedAt)) }}
                    </td>
                    <td class="px-3 py-2 text-right text-xs text-muted whitespace-nowrap">
                      {{ ago(worker.lastActivityAt, now) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="space-y-2">
            <h2 class="font-medium">Orca hiccups and driver stops</h2>
            <p class="text-sm text-muted">The last {{ history }}, newest first.</p>
            <UEmpty v-if="!health.hiccups.length" icon="i-lucide-circle-check" title="None" />
            <ol v-else class="divide-y divide-default rounded-lg border border-default">
              <li
                v-for="(hiccup, index) in health.hiccups"
                :key="`${hiccup.at}:${hiccup.source.id}:${index}`"
                class="flex items-start gap-3 px-3 py-2 text-sm"
              >
                <StatusIcon :look="hiccupLook[hiccup.kind]" size="size-4" class="mt-0.5 shrink-0" />
                <div class="min-w-0 flex-1">
                  <p class="flex flex-wrap items-baseline gap-x-2">
                    <span class="font-medium">{{ hiccupLook[hiccup.kind].label }}</span>
                    <RouterLink :to="hiccup.source.link" class="text-muted hover:underline truncate max-w-md">
                      {{ hiccup.source.title }}
                    </RouterLink>
                  </p>
                  <p class="text-xs text-muted line-clamp-2" :title="hiccup.detail">{{ hiccup.detail }}</p>
                </div>
                <time class="text-xs text-dimmed shrink-0" :datetime="hiccup.at">{{ timeOfDay(hiccup.at) }}</time>
              </li>
            </ol>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
