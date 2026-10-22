<!-- Navigation: tasks (with how many need you), the other pages, the live connection and the colour mode. -->
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui';
import { computed } from 'vue';
import { useNotificationPermission } from '../composables/useAttention';
import { useComparisons } from '../composables/useComparisons';
import { useLive } from '../composables/useLive';
import { useTasks } from '../composables/useTasks';

const { needsYou } = useTasks();
const comparisons = useComparisons();
const { connected } = useLive();
const notifications = useNotificationPermission();

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: 'Tasks',
    icon: 'i-lucide-list-todo',
    to: '/',
    badge: needsYou.value.length
      ? { label: String(needsYou.value.length), color: 'warning', variant: 'solid' }
      : undefined,
  },
  {
    label: 'Comparisons',
    icon: 'i-lucide-git-compare-arrows',
    to: '/comparisons',
    badge: comparisons.needsYou.value.length
      ? { label: String(comparisons.needsYou.value.length), color: 'warning', variant: 'solid' }
      : undefined,
  },
  { label: 'Recipes', icon: 'i-lucide-chef-hat', to: '/recipes' },
  { label: 'Help', icon: 'i-lucide-circle-help', to: '/help' },
]);
</script>

<template>
  <UDashboardSidebar
    id="navigation"
    collapsible
    resizable
    :min-size="12"
    :default-size="14"
    :max-size="20"
    :collapsed-size="4"
    class="bg-elevated/25"
    :ui="{ footer: 'border-t border-default' }"
  >
    <template #header="{ collapsed }">
      <RouterLink to="/" class="flex items-center gap-2 min-w-0" aria-label="Grampus home">
        <img src="/icon.svg" alt="" class="size-7 shrink-0" />
        <span v-if="!collapsed" class="font-semibold tracking-tight truncate">Grampus</span>
      </RouterLink>
    </template>

    <template #default="{ collapsed }">
      <UButton
        to="/new"
        icon="i-lucide-plus"
        :label="collapsed ? undefined : 'New task'"
        :square="collapsed"
        block
        class="mb-2"
        aria-label="New task"
      />
      <UNavigationMenu :collapsed="collapsed" :items="items" orientation="vertical" tooltip popover />
    </template>

    <template #footer="{ collapsed }">
      <div class="flex items-center w-full gap-2" :class="collapsed ? 'flex-col' : 'justify-between'">
        <UTooltip :text="connected ? 'Live: updates arrive as they happen' : 'Reconnecting to Grampus...'">
          <span class="flex items-center gap-1.5 text-xs text-muted">
            <span class="size-2 rounded-full" :class="connected ? 'bg-success animate-pulse' : 'bg-error'" />
            <span v-if="!collapsed">{{ connected ? 'Live' : 'Offline' }}</span>
          </span>
        </UTooltip>
        <div class="flex items-center" :class="{ 'flex-col': collapsed }">
          <UTooltip
            v-if="notifications.supported && notifications.permission.value !== 'granted'"
            :text="
              notifications.permission.value === 'denied'
                ? 'Notifications are blocked in this browser'
                : 'Notify me when something needs me'
            "
          >
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-lucide-bell-off"
              aria-label="Turn on notifications"
              :disabled="notifications.permission.value === 'denied'"
              @click="notifications.request()"
            />
          </UTooltip>
          <UColorModeButton size="sm" />
        </div>
      </div>
    </template>
  </UDashboardSidebar>
</template>
