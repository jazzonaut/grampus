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
 * - `sidebar`: New task, the task and planning lists. Rendered inside a labelled `<nav>`.
 * - `default`: the open screen. Rendered inside `<main id="main">`, the skip link target.
 * - `footer`: optional version and build line under the main area.
 */
import { ref, useId, useTemplateRef } from 'vue';

defineOptions({ name: 'AppShell' });

withDefaults(defineProps<{ title?: string; announcement?: string }>(), { title: 'Grampus', announcement: '' });

// Relative to the page, so the server can mount the app anywhere.
const logo = `${import.meta.env.BASE_URL}favicon.svg`;

const navigationOpen = ref(false);
const navigationId = useId();
const main = useTemplateRef<HTMLElement>('main');

// The URL fragment carries the access token, so the skip link moves focus without navigating.
function skipToMain(): void {
  main.value?.focus();
}

const slots = defineSlots<{
  health?: () => unknown;
  breadcrumb?: () => unknown;
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
      Skip to main content
    </a>
    <div class="grid min-h-screen md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[4rem_1fr_auto]">
      <nav
        aria-label="Tasks and planning"
        class="border-b border-default bg-muted/60 p-4 md:sticky md:top-0 md:row-span-3 md:h-screen md:overflow-y-auto md:border-r md:border-b-0"
      >
        <div class="mb-5 flex items-center justify-between gap-3">
          <a href="#/" class="flex items-center gap-3 px-2 text-xl font-semibold tracking-tight text-highlighted">
            <img :src="logo" alt="" class="size-8" width="32" height="32" /><span>{{ title }}</span>
          </a>
          <button
            type="button"
            class="grampus-link-button md:hidden"
            :aria-controls="navigationId"
            :aria-expanded="navigationOpen"
            @click="navigationOpen = !navigationOpen"
          >
            Menu
          </button>
        </div>
        <div :id="navigationId" :class="navigationOpen ? 'block' : 'hidden md:block'"><slot name="sidebar" /></div>
      </nav>
      <header
        class="flex min-w-0 items-center justify-between gap-4 border-b border-default bg-default px-5 py-4 md:px-8"
      >
        <slot name="breadcrumb"><span class="text-sm text-muted">Local controller</span></slot>
        <div class="ml-auto flex shrink-0 items-center gap-2"><slot name="health" /></div>
      </header>
      <main id="main" ref="main" tabindex="-1" class="min-w-0 bg-muted/20 p-5 focus:outline-none md:p-8"><slot /></main>
      <footer
        v-if="slots.footer"
        class="min-w-0 border-t border-default bg-default px-5 py-3 text-xs break-all text-muted md:col-start-2 md:px-8"
      >
        <slot name="footer" />
      </footer>
    </div>
    <div role="status" aria-live="polite" aria-atomic="true" class="sr-only">{{ announcement }}</div>
  </div>
</template>
