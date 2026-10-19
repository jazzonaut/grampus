<script setup lang="ts">
/**
 * ActionForm: the form of one `ActionView` (answers, assessment, revision, message, file hints or
 * reference folders), generated from the server's field list. Typed text survives polling: drafts are
 * kept while the action's decision key and fields are unchanged, and start afresh when the state they
 * were typed for has changed.
 *
 * Props:
 * - `action`: the `ActionView` with a `form`.
 * - `busy`: a request is in flight or waits for the server; the submit button is disabled.
 * - `sending`: this form's request is in flight.
 * - `issues`: problems found on submit, by field name.
 *
 * Emits `submit` with the drafts; the page sends them with `useActions().run`.
 *
 * Slots:
 * - `field-extra`: `{ field, append }` under each field, e.g. file search results or reference
 *   suggestions that `append(line)` to a `lines` field.
 */
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { ActionView, FormField } from '../../../src/server/api-types';
import { initialDrafts, type FieldDraft, type FieldIssue, type FormDrafts } from '../api/actions';
import FormFieldInput from './FormFieldInput.vue';
import MarkdownView from './MarkdownView.vue';

defineOptions({ name: 'ActionForm' });

const props = withDefaults(
  defineProps<{
    action: ActionView;
    busy?: boolean;
    sending?: boolean;
    issues?: readonly FieldIssue[];
    draftKey?: string;
  }>(),
  { busy: false, sending: false, issues: () => [] },
);

const emit = defineEmits<{ submit: [drafts: FormDrafts] }>();

defineSlots<{ 'field-extra'?: (props: { field: FormField; append: (line: string) => void }) => unknown }>();

const identity = computed(
  () =>
    `${props.action.id}|${props.draftKey ?? props.action.expected ?? ''}|${(props.action.form?.fields ?? []).map(f => f.name).join()}`,
);
const drafts = ref<FormDrafts>(initialDrafts(props.action.form));
watch(identity, () => {
  drafts.value = initialDrafts(props.action.form);
});

function draftOf(field: FormField): FieldDraft {
  return drafts.value[field.name] ?? { kind: 'text', text: '' };
}

function update(field: FormField, value: FieldDraft): void {
  drafts.value = { ...drafts.value, [field.name]: value };
}

/** Adds a line to a `lines` field unless it is already listed. */
function append(field: FormField, line: string): void {
  const current = draftOf(field);
  const text = current.kind === 'text' ? current.text : '';
  const lines = text.split(/\r?\n/).map(item => item.trim());
  if (lines.includes(line)) return;
  update(field, { kind: 'text', text: [...lines.filter(Boolean), line].join('\n') });
}

function issueOf(field: FormField): string | undefined {
  return props.issues.find(issue => issue.field === field.name)?.message;
}

function submit(): void {
  emit('submit', drafts.value);
}

/** Clears what was typed, e.g. after a message was sent. */
function reset(): void {
  drafts.value = initialDrafts(props.action.form);
}

defineExpose({ reset });
</script>

<template>
  <form
    v-if="action.form"
    :class="action.form.kind === 'settings' ? 'grid gap-6 lg:grid-cols-2' : 'flex flex-col gap-4'"
    novalidate
    :data-form="action.form.kind"
    @submit.prevent="submit"
  >
    <div v-if="action.form.intro" class="col-span-full text-sm text-toned">
      <MarkdownView :source="action.form.intro" />
    </div>
    <div
      v-for="field in action.form.fields"
      :key="field.name"
      :class="['flex flex-col gap-2', field.input === 'json' || field.input === 'textarea' ? 'col-span-full' : '']"
    >
      <FormFieldInput
        :field="field"
        :model-value="draftOf(field)"
        :issue="issueOf(field)"
        @update:model-value="value => update(field, value)"
      />
      <slot name="field-extra" :field="field" :append="(line: string) => append(field, line)" />
    </div>
    <p v-if="issues.length" role="alert" class="col-span-full text-sm text-error">
      Check the {{ issues.length === 1 ? 'field' : 'fields' }} marked above; nothing was sent.
    </p>
    <div class="col-span-full flex flex-col gap-1">
      <UButton
        type="submit"
        :label="action.form.submitLabel"
        :color="action.kind === 'danger' ? 'error' : action.kind === 'primary' ? 'primary' : 'neutral'"
        :variant="action.kind === 'secondary' ? 'outline' : 'solid'"
        :disabled="busy || !action.enabled"
        :loading="sending"
        class="self-start"
      />
      <p v-if="action.disabledReason" class="text-xs text-muted" data-disabled-reason>{{ action.disabledReason }}</p>
    </div>
  </form>
</template>
