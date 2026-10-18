<script setup lang="ts">
/**
 * AppShell: the page frame. A header with the product name and a health indicator, a sidebar
 * for the task list and a main area for the selected task.
 *
 * Props:
 * - `title`: product name in the header, default "Grampus".
 * - `announcement`: text read out by screen readers through a polite live region whenever it
 *   changes, e.g. "Task moved to review". Keep it short; it is not shown visually.
 *
 * Slots:
 * - `health`: compact integration or server health indicator, right of the header.
 * - `sidebar`: the task list. Rendered inside a labelled `<nav>`.
 * - `default`: the main area. Rendered inside `<main id="main">`, the skip link target.
 * - `footer`: optional version and build line under the main area.
 */
import { useTemplateRef } from 'vue';

defineOptions({ name: 'AppShell' });

withDefaults(defineProps<{ title?: string; announcement?: string }>(), { title: 'Grampus', announcement: '' });

// Relative to the page, so the server can mount the app anywhere.
const logo = `${import.meta.env.BASE_URL}favicon.svg`;

const main = useTemplateRef<HTMLElement>('main');

// The URL fragment carries the access token, so the skip link moves focus without navigating.
function skipToMain(): void {
  main.value?.focus();
}

const slots = defineSlots<{
  health?: () => unknown;
  sidebar?: () => unknown;
  default?: () => unknown;
  footer?: () => unknown;
}>();
</script>

<template>
  <div class="flex min-h-screen flex-col bg-default text-default">
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-default focus:px-3 focus:py-2 focus:ring-2 focus:ring-primary"
      @click.prevent="skipToMain"
    >
      Skip to task
    </a>
    <header class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-default bg-default px-4">
      <div class="flex items-center gap-2 font-semibold text-highlighted">
        <img :src="logo" alt="" class="size-6" width="24" height="24" />
        <span>{{ title }}</span>
      </div>
      <div class="flex items-center gap-2">
        <slot name="health" />
      </div>
    </header>
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label="Tasks"
        class="shrink-0 border-b border-default bg-muted p-3 md:w-72 md:overflow-y-auto md:border-r md:border-b-0"
      >
        <slot name="sidebar" />
      </nav>
      <div class="flex min-w-0 flex-1 flex-col">
        <main id="main" ref="main" tabindex="-1" class="flex-1 p-4 focus:outline-none md:p-6">
          <slot />
        </main>
        <footer v-if="slots.footer" class="border-t border-default px-4 py-2 text-xs text-muted md:px-6">
          <slot name="footer" />
        </footer>
      </div>
    </div>
    <div role="status" aria-live="polite" aria-atomic="true" class="sr-only">{{ announcement }}</div>
  </div>
</template>
