<script setup lang="ts">
/** Owns the compact feedback composer while retaining the server's form and request contract. */
import type { ActionView } from '../../../src/server/api-types';
import type { FieldIssue, FormDrafts } from '../api/actions';
import ActionForm from './ActionForm.vue';
defineProps<{ action: ActionView; busy: boolean; sending: boolean; issues: readonly FieldIssue[] }>();
const emit = defineEmits<{ run: [drafts: FormDrafts] }>();
</script>

<template>
  <section
    class="rounded-xl border border-default bg-default p-4 shadow-sm"
    :aria-label="action.label"
    :data-decision="action.id"
  >
    <ActionForm
      :action="action"
      :busy="busy"
      :sending="sending"
      :issues="issues"
      @submit="drafts => emit('run', drafts)"
    />
    <p class="mt-2 text-xs text-muted">{{ action.description }}</p>
  </section>
</template>
