<script setup lang="ts">
/**
 * EvidenceSection: a collapsible block of evidence (check output, findings, retained changes)
 * whose content is created only when first opened.
 *
 * Large evidence is never rendered, or fetched, until someone asks for it. After the first
 * opening the content stays mounted, so closing and reopening does not fetch again.
 *
 * Props:
 * - `title`: the section heading, e.g. "Validation output".
 * - `summary`: one-line summary shown while collapsed, e.g. "2 checks, 1 failed".
 * - `status`: optional status badge beside the title.
 * - `defaultOpen`: start expanded, default false.
 *
 * Emits `firstOpen` once, when the content is first shown: the place to start a fetch.
 *
 * Slots:
 * - `default`: the evidence itself. Only rendered after the first opening.
 */
import { onMounted, ref, useId } from 'vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import StatusBadge from './StatusBadge.vue';
import type { Status } from './types';

defineOptions({ name: 'EvidenceSection' });

const props = withDefaults(defineProps<{ title: string; summary?: string; status?: Status; defaultOpen?: boolean }>(), {
  summary: '',
  defaultOpen: false,
});

const emit = defineEmits<{ firstOpen: [] }>();

defineSlots<{ default?: () => unknown }>();

const open = ref(false);
const opened = ref(false);
const panelId = useId();

function toggle(): void {
  open.value = !open.value;
  if (open.value && !opened.value) {
    opened.value = true;
    emit('firstOpen');
  }
}

onMounted(() => {
  if (props.defaultOpen) toggle();
});
</script>

<template>
  <section class="rounded-lg border border-default bg-default">
    <h3 class="m-0">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        :aria-expanded="open"
        :aria-controls="panelId"
        @click="toggle"
      >
        <UIcon
          name="i-lucide-chevron-right"
          :class="['size-4 shrink-0 text-muted motion-safe:transition-transform', open ? 'rotate-90' : '']"
          aria-hidden="true"
        />
        <span class="font-medium text-highlighted">{{ title }}</span>
        <StatusBadge v-if="status" :status="status" size="sm" />
        <span v-if="summary" class="ml-auto truncate text-sm text-muted">{{ summary }}</span>
      </button>
    </h3>
    <div v-show="open" :id="panelId" class="border-t border-default px-4 py-3">
      <slot v-if="opened" />
    </div>
  </section>
</template>
