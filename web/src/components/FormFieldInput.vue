<script setup lang="ts">
/**
 * FormFieldInput: one field of a server-described form (`FormField`), as a labelled native control.
 * Answer suggestions fill the field for editing; they are never sent by themselves.
 *
 * Props:
 * - `field`: the server's field (label, input kind, options, bounds, help, suggestions).
 * - `issue`: the problem to show under the field after a submit, if any.
 *
 * `v-model` is the field's `FieldDraft`.
 */
import { computed, useId } from 'vue';
import type { FormField } from '../../../src/server/api-types';
import type { FieldDraft } from '../api/actions';
import MarkdownView from './MarkdownView.vue';
import MultiSelectField from './MultiSelectField.vue';

defineOptions({ name: 'FormFieldInput' });

const props = defineProps<{ field: FormField; issue?: string | undefined }>();
const draft = defineModel<FieldDraft>({ required: true });

const id = useId();
const helpId = `${id}-help`;
const issueId = `${id}-issue`;
const describedBy = computed(
  () => [props.field.help ? helpId : '', props.issue ? issueId : ''].filter(Boolean).join(' ') || undefined,
);

const text = computed({
  get: () => (draft.value.kind === 'text' ? draft.value.text : ''),
  set: (value: string) => {
    draft.value = { kind: 'text', text: value };
  },
});

const choice = computed({
  get: () => (draft.value.kind === 'choice' && draft.value.index !== null ? String(draft.value.index) : ''),
  set: (value: string) => {
    draft.value = { kind: 'choice', index: value === '' ? null : Number(value) };
  },
});

const indices = computed({
  get: () => (draft.value.kind === 'choices' ? draft.value.indices : []),
  set: (value: number[]) => {
    draft.value = { kind: 'choices', indices: value };
  },
});

const rows = computed(() => {
  if (props.field.input === 'json') return 14;
  if (props.field.input === 'lines') return 6;
  return props.field.input === 'textarea' ? 3 : 1;
});

const control =
  'w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-primary aria-[invalid=true]:border-error';
</script>

<template>
  <div class="flex flex-col gap-1.5" :data-field="field.name">
    <label
      :id="`${id}-label`"
      :for="field.input === 'multiselect' ? undefined : id"
      class="text-sm font-medium text-highlighted"
    >
      <MarkdownView :source="field.label" inline />
      <span v-if="field.required" class="sr-only"> (required)</span>
    </label>
    <ul v-if="field.suggestions.length" class="flex flex-wrap gap-2" aria-label="Suggested answers">
      <li v-for="suggestion in field.suggestions" :key="suggestion">
        <button
          type="button"
          :aria-controls="id"
          class="rounded-md border border-accented bg-muted px-2 py-1 text-left text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
          data-suggestion
          @click="text = suggestion"
        >
          <MarkdownView :source="suggestion" inline />
        </button>
      </li>
    </ul>
    <select
      v-if="field.input === 'select'"
      :id="id"
      v-model="choice"
      :required="field.required"
      :aria-invalid="issue ? 'true' : undefined"
      :aria-describedby="describedBy"
      :class="control"
    >
      <option value="" disabled>Choose…</option>
      <option v-for="(option, index) in field.options" :key="index" :value="String(index)">
        {{ option.label }}{{ option.description ? ` (${option.description})` : '' }}
      </option>
    </select>
    <MultiSelectField
      v-else-if="field.input === 'multiselect'"
      v-model="indices"
      :options="field.options"
      :labelled-by="`${id}-label`"
      :described-by="describedBy"
    />
    <input
      v-else-if="field.input === 'text' || field.input === 'number'"
      :id="id"
      v-model="text"
      :type="field.input === 'number' ? 'number' : 'text'"
      :min="field.min ?? undefined"
      :max="field.max ?? undefined"
      :step="field.step ?? undefined"
      :required="field.required"
      :placeholder="field.placeholder ?? undefined"
      :aria-invalid="issue ? 'true' : undefined"
      :aria-describedby="describedBy"
      :class="control"
    />
    <textarea
      v-else
      :id="id"
      v-model="text"
      :rows="rows"
      :required="field.required"
      :placeholder="field.placeholder ?? undefined"
      :aria-invalid="issue ? 'true' : undefined"
      :aria-describedby="describedBy"
      :spellcheck="field.input === 'textarea'"
      :class="[control, field.input === 'json' || field.input === 'lines' ? 'font-mono text-xs' : '']"
    />
    <div v-if="field.help" :id="helpId" class="text-xs text-muted"><MarkdownView :source="field.help" /></div>
    <p v-if="issue" :id="issueId" class="text-sm text-error" data-issue>{{ issue }}</p>
  </div>
</template>
