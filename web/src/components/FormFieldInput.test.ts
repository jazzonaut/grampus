import { afterEach, describe, expect, it } from 'vitest';
import type { FormField } from '../../../src/server/api-types';
import { fieldValue, type FieldDraft } from '../api/actions';
import FormFieldInput from './FormFieldInput.vue';
import { render } from '../testing';

afterEach(() => {
  document.body.innerHTML = '';
});

const repairRounds: FormField = {
  name: 'repairRounds',
  label: 'Repair rounds',
  input: 'number',
  value: 2,
  required: true,
  help: null,
  suggestions: [],
  options: [],
  min: 0,
  max: 5,
  step: null,
  placeholder: null,
  target: '/plan/workflowPolicy/repairRounds',
};

describe('FormFieldInput', () => {
  it('keeps a typed number as text, so it converts like any other draft', async () => {
    const drafts: FieldDraft[] = [];
    const wrapper = await render(FormFieldInput, {
      field: repairRounds,
      modelValue: { kind: 'text', text: '2' },
      'onUpdate:modelValue': (draft: FieldDraft) => drafts.push(draft),
    });
    await wrapper.get('input').setValue('3');
    expect(drafts.at(-1)).toEqual({ kind: 'text', text: '3' });
    expect(fieldValue(repairRounds, drafts.at(-1))).toEqual({ ok: true, value: 3 });
  });
});
