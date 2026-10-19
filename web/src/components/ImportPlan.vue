<script setup lang="ts">
/**
 * ImportPlan: for advanced use, an authored guided plan as JSON (`POST /api/tasks`), prepared as an
 * unapproved task for review. Nothing runs until it is approved.
 *
 * Emits `created` with the new task id.
 */
import { ref, useId } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { CreatedResponse } from '../../../src/server/api-types';
import { ApiError, postUnkeyed } from '../api/client';

defineOptions({ name: 'ImportPlan' });

const emit = defineEmits<{ created: [id: string] }>();

const id = useId();
const text = ref('');
const error = ref('');
const issues = ref<readonly string[]>([]);
const sending = ref(false);

async function submit(): Promise<void> {
  error.value = '';
  issues.value = [];
  let plan: unknown;
  try {
    plan = JSON.parse(text.value);
  } catch (caught) {
    error.value = `This is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`;
    return;
  }
  sending.value = true;
  try {
    emit('created', (await postUnkeyed<CreatedResponse>('/api/tasks', { plan })).id);
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught);
    issues.value = caught instanceof ApiError ? caught.issues : [];
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <details class="rounded-lg border border-default" data-panel="import">
    <summary class="cursor-pointer px-4 py-3 text-sm font-medium select-none hover:bg-muted">
      Already have a guided plan?
    </summary>
    <form class="flex flex-col gap-2 border-t border-default p-4" @submit.prevent="submit">
      <label :for="id" class="text-sm font-medium text-highlighted">Import plan JSON</label>
      <textarea
        :id="id"
        v-model="text"
        rows="9"
        required
        class="grampus-input font-mono text-xs"
        spellcheck="false"
        :aria-invalid="error ? 'true' : undefined"
      />
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <ul v-if="issues.length" class="list-disc pl-5 text-sm text-error">
        <li v-for="issue in issues" :key="issue">{{ issue }}</li>
      </ul>
      <UButton
        type="submit"
        label="Import for approval"
        color="neutral"
        variant="outline"
        class="self-start"
        :loading="sending"
        :disabled="!text.trim()"
      />
    </form>
  </details>
</template>
