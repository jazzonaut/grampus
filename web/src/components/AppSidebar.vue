<script setup lang="ts">
/**
 * AppSidebar: New task, then every task and planning conversation with its status in words and a stall
 * badge, and the Health and Settings screens. The open item is marked `aria-current="page"`.
 *
 * Props:
 * - `overview`: the latest overview, or undefined while it loads.
 * - `current`: the open route.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { OverviewV1 } from '../../../src/server/api-types';
import { useNow } from '../announcer';
import { href, type Route } from '../router';
import StatusBadge from './StatusBadge.vue';
import { minutesSince } from './format';

defineOptions({ name: 'AppSidebar' });

defineProps<{ overview: OverviewV1 | undefined; current: Route }>();

const now = useNow();

const item =
  'flex flex-col gap-1 rounded-lg px-3 py-2 text-sm text-toned hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary aria-[current=page]:font-medium';
</script>

<template>
  <div class="flex flex-col gap-4">
    <a
      :href="href({ name: 'new' })"
      :aria-current="current.name === 'new' ? 'page' : undefined"
      class="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-inverted hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <UIcon name="i-lucide-circle-plus" class="mr-2 size-4" aria-hidden="true" /> New task
    </a>
    <a :href="href({ name: 'home' })" :aria-current="current.name === 'home' ? 'page' : undefined" :class="item"
      ><span class="flex items-center gap-3"
        ><UIcon name="i-lucide-house" class="size-4" aria-hidden="true" />Overview</span
      ></a
    >
    <div class="border-t border-default pt-4">
      <h2 class="px-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Tasks</h2>
      <ul v-if="overview?.tasks.length" class="flex flex-col gap-0.5">
        <li v-for="task in overview.tasks" :key="task.id">
          <a
            :href="href({ name: 'task', id: task.id })"
            :aria-current="current.name === 'task' && current.id === task.id ? 'page' : undefined"
            :class="item"
          >
            <span class="truncate text-highlighted">{{ task.title }}</span>
            <span class="flex flex-wrap gap-1">
              <StatusBadge :status="task.status" :label="task.statusLabel" size="sm" />
              <UBadge
                v-if="task.stalled"
                :label="`No activity for ${minutesSince(task.stalled.lastActivityAt, now)} min`"
                color="warning"
                variant="outline"
                size="sm"
              />
            </span>
          </a>
        </li>
      </ul>
      <p v-else class="px-2 text-xs text-muted">No tasks yet.</p>
    </div>
    <div class="border-t border-default pt-4">
      <h2 class="px-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Planning</h2>
      <ul v-if="overview?.planning.length" class="flex flex-col gap-0.5">
        <li v-for="kickoff in overview.planning" :key="kickoff.id">
          <a
            :href="href({ name: 'planning', id: kickoff.id })"
            :aria-current="current.name === 'planning' && current.id === kickoff.id ? 'page' : undefined"
            :class="item"
          >
            <span class="truncate text-highlighted">{{ kickoff.title }}</span>
            <StatusBadge :status="kickoff.status" :label="kickoff.statusLabel" size="sm" class="self-start" />
          </a>
        </li>
      </ul>
      <p v-else class="px-2 text-xs text-muted">No planning conversations.</p>
    </div>
    <a :href="href({ name: 'health' })" :aria-current="current.name === 'health' ? 'page' : undefined" :class="item"
      ><span class="flex items-center gap-3"
        ><UIcon name="i-lucide-plug" class="size-4" aria-hidden="true" />Integration health</span
      ></a
    >
    <a :href="href({ name: 'settings' })" :aria-current="current.name === 'settings' ? 'page' : undefined" :class="item"
      ><span class="flex items-center gap-3"
        ><UIcon name="i-lucide-settings" class="size-4" aria-hidden="true" />Settings</span
      ></a
    >
  </div>
</template>
