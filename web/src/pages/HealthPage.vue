<script setup lang="ts">
/**
 * HealthPage: every integration Grampus depends on (Codex, Claude, Git, Node, Windows PowerShell, Orca)
 * with its version and a status per capability, when it was checked, and version-change warnings since
 * the last successful delivery. "Check again" reruns the inference-free checks (`GET /api/health?refresh=1`)
 * and then reads the overview again. Health is informational and never blocks a task.
 *
 * Props:
 * - `overview`: the latest overview (its `health`), or undefined while it loads.
 * - `refresh`: fetches the overview again.
 */
import { ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { OverviewV1 } from '../../../src/server/api-types';
import { ApiError, get } from '../api/client';
import { announce, useNow } from '../announcer';
import NoticeBox from '../components/NoticeBox.vue';
import { elapsedSince, localTime } from '../components/format';
import { healthPresentation, integrationPresentation, textTone } from '../theme/status';

defineOptions({ name: 'HealthPage' });

const props = defineProps<{ overview: OverviewV1 | undefined; refresh: () => Promise<void> }>();

const now = useNow();
const checking = ref(false);
const error = ref('');

async function checkAgain(): Promise<void> {
  checking.value = true;
  error.value = '';
  announce('Checking integrations again. This takes a few seconds and sends no inference.');
  try {
    await get<unknown>('/api/health?refresh=1');
    await props.refresh();
    announce(`Health checked: ${props.overview?.health.label ?? 'done'}`);
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold text-highlighted">Integration health</h1>
      <UButton
        label="Check again"
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="outline"
        :loading="checking"
        @click="checkAgain"
      />
    </div>
    <p v-if="!overview" class="text-sm text-muted" role="status">Loading health…</p>
    <template v-else>
      <section
        class="flex flex-col gap-2 rounded-lg border border-default p-4"
        aria-labelledby="overall-heading"
        data-panel="overall"
      >
        <div class="flex items-center gap-2">
          <UIcon
            :name="healthPresentation[overview.health.overall].icon"
            :class="['size-5', textTone[healthPresentation[overview.health.overall].color]]"
            aria-hidden="true"
          />
          <h2 id="overall-heading" class="font-semibold text-highlighted" :data-overall="overview.health.overall">
            {{ overview.health.label }}
          </h2>
        </div>
        <p class="text-sm text-toned">{{ overview.health.reason }}</p>
        <p class="text-xs text-muted" data-checked>
          <template v-if="overview.health.checkedAt">
            Checked {{ localTime(overview.health.checkedAt) }} ({{
              elapsedSince(overview.health.checkedAt, now)
            }}
            ago)<template v-if="overview.health.stale"> · due for a new check</template>
          </template>
          <template v-else>Not checked yet.</template>
          Checks run the real executables and handshakes without inference, when the dashboard starts and before a run
          if the stored result is old.
        </p>
      </section>
      <p v-if="checking" role="status" class="text-sm text-muted">
        Checking… this takes a few seconds and sends no inference.
      </p>
      <NoticeBox v-if="error" tone="error" title="The check could not run" live="alert">{{ error }}</NoticeBox>
      <NoticeBox
        v-for="warning in overview.health.warnings"
        :key="warning"
        tone="warning"
        title="Version changed since the last delivery"
      >
        {{ warning }} Grampus does not block on it: run a small, low-risk task first and watch for protocol errors.
      </NoticeBox>
      <p v-if="!overview.health.integrations.length" class="text-sm text-muted">
        No integration results are stored yet. Choose Check again.
      </p>
      <section
        v-for="integration in overview.health.integrations"
        :key="integration.id"
        :aria-labelledby="`integration-${integration.id}`"
        class="rounded-lg border border-default p-4"
        :data-integration="integration.id"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UIcon
            :name="integrationPresentation[integration.status].icon"
            :class="['size-4', textTone[integrationPresentation[integration.status].color]]"
            aria-hidden="true"
          />
          <h2 :id="`integration-${integration.id}`" class="font-semibold text-highlighted">{{ integration.label }}</h2>
          <span class="text-sm">{{ integration.statusLabel }}</span>
          <span class="text-xs text-muted">{{ integration.required ? 'Required' : 'Optional' }}</span>
          <span class="ml-auto font-mono text-xs text-muted">
            {{ integration.version ?? 'Version unknown'
            }}<template v-if="integration.sdkVersion"> · SDK {{ integration.sdkVersion }}</template>
          </span>
        </div>
        <div class="mt-2 overflow-x-auto">
          <table class="w-full table-fixed text-sm">
            <caption class="sr-only">
              {{
                integration.label
              }}
              capabilities
            </caption>
            <thead>
              <tr class="border-b border-default text-left text-xs text-muted">
                <th scope="col" class="w-1/3 py-1 pr-3 font-medium">Capability</th>
                <th scope="col" class="w-1/4 py-1 pr-3 font-medium">Status</th>
                <th scope="col" class="py-1 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="capability in integration.capabilities"
                :key="capability.name"
                class="border-b border-muted align-top last:border-0"
                :data-capability="capability.name"
              >
                <th scope="row" class="py-1.5 pr-3 text-left font-medium">{{ capability.label }}</th>
                <td class="py-1.5 pr-3">
                  <span class="inline-flex items-center gap-1">
                    <UIcon
                      :name="integrationPresentation[capability.status].icon"
                      :class="['size-3.5', textTone[integrationPresentation[capability.status].color]]"
                      aria-hidden="true"
                    />
                    {{ capability.statusLabel }}
                  </span>
                </td>
                <td class="py-1.5 text-xs break-words text-toned">{{ capability.detail }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
