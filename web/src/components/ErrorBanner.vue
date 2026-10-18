<script setup lang="ts">
/**
 * ErrorBanner: a failure the user should know about, announced to screen readers.
 *
 * Use `kind="access"` when the server refused the access token: only a fresh link from the
 * Grampus terminal helps, so the banner says exactly that and offers no retry.
 *
 * Props:
 * - `message`: what went wrong, in plain language. Server error text is shown as is.
 * - `title`: heading, default "Something went wrong" (or "Access link needed" for `access`).
 * - `kind`: `error` (default) or `access`.
 * - `retryLabel`: label of the retry button; omit to hide it.
 * - `dismissible`: show a dismiss button, default false.
 *
 * Emits `retry` and `dismiss`.
 */
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';

defineOptions({ name: 'ErrorBanner' });

const props = withDefaults(
  defineProps<{
    message: string;
    title?: string;
    kind?: 'error' | 'access';
    retryLabel?: string;
    dismissible?: boolean;
  }>(),
  { kind: 'error', dismissible: false },
);

const emit = defineEmits<{ retry: []; dismiss: [] }>();

const heading = computed(
  () => props.title ?? (props.kind === 'access' ? 'Access link needed' : 'Something went wrong'),
);
</script>

<template>
  <div
    role="alert"
    :class="[
      'flex items-start gap-3 rounded-lg border px-4 py-3',
      kind === 'access' ? 'border-warning/40 bg-warning/10' : 'border-error/40 bg-error/10',
    ]"
  >
    <UIcon
      :name="kind === 'access' ? 'i-lucide-key-round' : 'i-lucide-triangle-alert'"
      :class="['mt-0.5 size-5 shrink-0', kind === 'access' ? 'text-warning' : 'text-error']"
      aria-hidden="true"
    />
    <div class="min-w-0 flex-1">
      <p class="font-semibold text-highlighted">{{ heading }}</p>
      <p class="text-sm break-words whitespace-pre-line text-default">{{ message }}</p>
      <UButton
        v-if="retryLabel && kind !== 'access'"
        :label="retryLabel"
        color="neutral"
        variant="outline"
        size="sm"
        class="mt-2"
        @click="emit('retry')"
      />
    </div>
    <UButton
      v-if="dismissible"
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="Dismiss message"
      @click="emit('dismiss')"
    />
  </div>
</template>
