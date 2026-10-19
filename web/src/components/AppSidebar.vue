<script setup lang="ts">
/**
 * AppSidebar: New task, then every task and planning conversation with its status in words and a stall
 * badge, and the Health screen. The open item is marked `aria-current="page"`.
 *
 * Props:
 * - `overview`: the latest overview, or undefined while it loads.
 * - `current`: the open route.
 */
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
  'flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary aria-[current=page]:bg-elevated aria-[current=page]:font-medium';
</script>

<template>
  <div class="flex flex-col gap-4">
    <a
      :href="href({ name: 'new' })"
      :aria-current="current.name === 'new' ? 'page' : undefined"
      class="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-inverted hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      New task
    </a>
    <a :href="href({ name: 'home' })" :aria-current="current.name === 'home' ? 'page' : undefined" :class="item"
      >Overview</a
    >
    <div>
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
    <div>
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
      >Integration health</a
    >
  </div>
</template>
