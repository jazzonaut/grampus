<!--
  Navigation: tasks (with how many need you), the other pages, the live connection and the colour mode.
  On wide screens it is an icon rail that widens over the page while hovered or focused, so the panels
  beside it never move. Narrow screens open it as a slideover from the page header instead.
-->
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useNotificationPermission } from '../composables/useAttention';
import { useComparisons } from '../composables/useComparisons';
import { useLive } from '../composables/useLive';
import { useTasks } from '../composables/useTasks';

const { needsYou } = useTasks();
const comparisons = useComparisons();
const { connected } = useLive();
const notifications = useNotificationPermission();

// The rail exists only from Tailwind's lg breakpoint; below it the slideover always shows labels.
const wide = window.matchMedia('(min-width: 64rem)');
const isWide = ref(wide.matches);
const onWidth = (event: MediaQueryListEvent): void => void (isWide.value = event.matches);
wide.addEventListener('change', onWidth);

/** Opening waits a moment so the pointer crossing the rail on its way elsewhere does not flash it open. */
const expanded = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
function hover(open: boolean): void {
  clearTimeout(timer);
  timer = setTimeout(() => (expanded.value = open), open ? 150 : 100);
}
function leaveFocus(event: FocusEvent): void {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) expanded.value = false;
}
const route = useRoute();
watch(
  () => route.fullPath,
  () => {
    clearTimeout(timer);
    expanded.value = false;
  },
);
onBeforeUnmount(() => {
  clearTimeout(timer);
  wide.removeEventListener('change', onWidth);
});
const collapsed = computed(() => isWide.value && !expanded.value);

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
  <!-- Holds the rail's place, so the widened sidebar covers the panels instead of pushing them. -->
  <div class="hidden lg:block w-16 shrink-0" aria-hidden="true" />
  <UDashboardSidebar
    id="navigation"
    class="bg-default lg:absolute lg:inset-y-0 lg:left-0 lg:z-50 overflow-hidden transition-[width,box-shadow] duration-200"
    :class="collapsed ? 'w-16' : 'w-56 shadow-xl'"
    :ui="{ footer: 'border-t border-default' }"
    @mouseenter="hover(true)"
    @mouseleave="hover(false)"
    @focusin="expanded = true"
    @focusout="leaveFocus"
  >
    <template #header>
      <RouterLink to="/" class="flex items-center gap-2 min-w-0" aria-label="Grampus home">
        <img src="/icon.svg" alt="" class="size-7 shrink-0" />
        <span v-if="!collapsed" class="font-semibold tracking-tight truncate">Grampus</span>
      </RouterLink>
    </template>

    <template #default>
      <UButton
        to="/new"
        icon="i-lucide-plus"
        :label="collapsed ? undefined : 'New task'"
        :square="collapsed"
        block
        class="mb-2"
        aria-label="New task"
      />
      <UNavigationMenu :collapsed="collapsed" :items="items" orientation="vertical" />
    </template>

    <template #footer>
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
