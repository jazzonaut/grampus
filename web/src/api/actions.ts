// Turns an `ActionView` and what the person typed into the exact request the server described. The server
// owns every rule: the body in `ActionView.request` already carries the decision key, version and digest,
// and each form field names the JSON pointer its value is written to (`/answers/<id>`, `/summary`,
// `/plan/brief/title`). This module only converts typed text to the field's JSON type and writes it there,
// in field order, so a later field overrides what an earlier `json` field wrote at the same place.
import type { ActionForm, ActionView, FormField, JsonValue } from '../../../src/server/api-types';

/** What the person has entered for one field, before conversion. */
export type FieldDraft =
  /** text, textarea, number, lines and json: the text as typed. */
  | { kind: 'text'; text: string }
  /** select: the index of the chosen option, or null for none. */
  | { kind: 'choice'; index: number | null }
  /** multiselect: indices of the chosen options, in chosen order. */
  | { kind: 'choices'; indices: number[] };

/** Drafts by field name. */
export type FormDrafts = Record<string, FieldDraft>;

/** One problem with what was entered, shown next to its field. */
export interface FieldIssue {
  field: string;
  message: string;
}

/** The request to send, or the problems to fix first. */
export type BuiltRequest =
  | { ok: true; method: 'GET' | 'POST'; path: string; body: Record<string, JsonValue> | null }
  | { ok: false; issues: FieldIssue[] };

function same(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function choiceDraft(field: FormField): FieldDraft {
  const index = field.options.findIndex(option => same(option.value, field.value));
  // A required select without a current value starts unchosen, so nothing is sent by accident.
  return { kind: 'choice', index: index >= 0 && !(field.required && field.value === null) ? index : null };
}

function choicesDraft(field: FormField): FieldDraft {
  const chosen = Array.isArray(field.value) ? field.value : [];
  const indices = chosen
    .map(value => field.options.findIndex(option => same(option.value, value)))
    .filter(index => index >= 0);
  return { kind: 'choices', indices };
}

/** The draft a field starts from: its current value, so editing starts where the server is. */
export function initialDraft(field: FormField): FieldDraft {
  switch (field.input) {
    case 'select':
      return choiceDraft(field);
    case 'multiselect':
      return choicesDraft(field);
    case 'lines':
      return { kind: 'text', text: Array.isArray(field.value) ? field.value.map(String).join('\n') : '' };
    case 'json':
      return { kind: 'text', text: field.value === null ? '' : JSON.stringify(field.value, null, 2) };
    case 'number':
      return { kind: 'text', text: typeof field.value === 'number' ? String(field.value) : '' };
    case 'text':
    case 'textarea':
      return { kind: 'text', text: typeof field.value === 'string' ? field.value : '' };
  }
}

/** Fresh drafts for every field of a form. */
export function initialDrafts(form: ActionForm | null): FormDrafts {
  return Object.fromEntries((form?.fields ?? []).map(field => [field.name, initialDraft(field)]));
}

type Converted = { ok: true; value: JsonValue | undefined } | { ok: false; message: string };

function textOf(draft: FieldDraft | undefined): string {
  return draft?.kind === 'text' ? draft.text : '';
}

function numberValue(field: FormField, text: string): Converted {
  if (text.trim() === '')
    return field.required ? { ok: false, message: 'Enter a number.' } : { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: 'Enter a number.' };
  if (field.min !== null && value < field.min) return { ok: false, message: `Enter ${field.min} or more.` };
  if (field.max !== null && value > field.max) return { ok: false, message: `Enter ${field.max} or less.` };
  return { ok: true, value };
}

function jsonValue(field: FormField, text: string): Converted {
  if (text.trim() === '')
    return field.required ? { ok: false, message: 'Enter JSON.' } : { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    return { ok: false, message: `This is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function choiceValue(field: FormField, draft: FieldDraft | undefined): Converted {
  const index = draft?.kind === 'choice' ? draft.index : null;
  const option = index === null ? undefined : field.options[index];
  if (!option) return field.required ? { ok: false, message: 'Choose an option.' } : { ok: true, value: undefined };
  // A null option value removes the property, e.g. "Stop for your decision" removes the arbitrator.
  return { ok: true, value: option.value === null ? undefined : option.value };
}

/** The JSON value a draft stands for, `undefined` to remove the property, or why it cannot be sent. */
export function fieldValue(field: FormField, draft: FieldDraft | undefined): Converted {
  switch (field.input) {
    case 'text':
    case 'textarea': {
      const text = textOf(draft);
      return field.required && text.trim() === ''
        ? { ok: false, message: 'This is required.' }
        : { ok: true, value: text };
    }
    case 'number':
      return numberValue(field, textOf(draft));
    case 'json':
      return jsonValue(field, textOf(draft));
    case 'lines': {
      const lines = textOf(draft)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
      return field.required && !lines.length
        ? { ok: false, message: 'Enter at least one line.' }
        : { ok: true, value: lines };
    }
    case 'select':
      return choiceValue(field, draft);
    case 'multiselect': {
      const indices = draft?.kind === 'choices' ? draft.indices : [];
      const values = indices.map(index => field.options[index]?.value).filter(value => value !== undefined);
      return { ok: true, value: values };
    }
  }
}

/** The segments of an RFC 6901 JSON pointer such as `/answers/output` or `/plan/brief/title`. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

type JsonContainer = { [key: string]: JsonValue } | JsonValue[];

function isContainer(value: JsonValue | undefined): value is JsonContainer {
  return typeof value === 'object' && value !== null;
}

/** Writes `value` at `pointer` in `body`, creating missing objects; `undefined` removes the property. */
export function writeAt(body: { [key: string]: JsonValue }, pointer: string, value: JsonValue | undefined): void {
  const segments = pointerSegments(pointer);
  const last = segments.pop();
  if (last === undefined) throw new Error('A form field cannot replace the whole request body');
  let node: JsonContainer = body;
  for (const segment of segments) {
    const record = node as { [key: string]: JsonValue };
    const next = record[segment];
    if (isContainer(next)) node = next;
    else {
      const created: { [key: string]: JsonValue } = {};
      record[segment] = created;
      node = created;
    }
  }
  const target = node as { [key: string]: JsonValue };
  if (value === undefined) Reflect.deleteProperty(target, last);
  else target[last] = value;
}

/**
 * The exact request for `action` with the entered drafts: a copy of `request.body` with every field's
 * value written at its target, in field order. Nothing is sent when a field has a problem.
 */
export function buildRequest(action: ActionView, drafts: FormDrafts = {}): BuiltRequest {
  const { method, path } = action.request;
  if (action.request.body === null) return { ok: true, method, path, body: null };
  // A JSON copy: the body is JSON by type, and views arrive as reactive proxies structuredClone refuses.
  const body = JSON.parse(JSON.stringify(action.request.body)) as Record<string, JsonValue>;
  const issues: FieldIssue[] = [];
  for (const field of action.form?.fields ?? []) {
    const converted = fieldValue(field, drafts[field.name] ?? initialDraft(field));
    if (!converted.ok) issues.push({ field: field.name, message: converted.message });
    else writeAt(body, field.target, converted.value);
  }
  return issues.length ? { ok: false, issues } : { ok: true, method, path, body };
}
