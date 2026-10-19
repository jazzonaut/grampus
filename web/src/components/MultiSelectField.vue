<script setup lang="ts">
/**
 * MultiSelectField: an ordered choice of options, e.g. quality passes. Checking an option appends it;
 * the chosen list can be reordered with Move up and Move down. The value is the list of chosen option
 * indices in chosen order.
 *
 * Props:
 * - `options`: the server's `FormOption`s.
 * - `labelledBy`: id of the field label.
 * - `describedBy`: ids of help and issue text.
 */
import { computed } from 'vue';
import type { FormOption } from '../../../src/server/api-types';

defineOptions({ name: 'MultiSelectField' });

const props = defineProps<{ options: readonly FormOption[]; labelledBy: string; describedBy?: string | undefined }>();
const chosen = defineModel<number[]>({ required: true });

const order = computed(() => chosen.value.map(index => ({ index, option: props.options[index] })));

function toggle(index: number, checked: boolean): void {
  chosen.value = checked
    ? [...chosen.value.filter(item => item !== index), index]
    : chosen.value.filter(item => item !== index);
}

function move(position: number, offset: -1 | 1): void {
  const next = [...chosen.value];
  const target = position + offset;
  const [item] = next.splice(position, 1);
  if (item === undefined || target < 0 || target > next.length) return;
  next.splice(target, 0, item);
  chosen.value = next;
}

const button =
  'rounded border border-default px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary';
</script>

<template>
  <div role="group" :aria-labelledby="labelledBy" :aria-describedby="describedBy" class="flex flex-col gap-2">
    <ul class="flex flex-col gap-1">
      <li v-for="(option, index) in options" :key="index">
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="chosen.includes(index)"
            @change="toggle(index, ($event.target as HTMLInputElement).checked)"
          />
          <span>
            {{ option.label }}
            <span v-if="option.description" class="block text-xs text-muted">{{ option.description }}</span>
          </span>
        </label>
      </li>
    </ul>
    <div v-if="order.length" class="rounded-md border border-default p-2">
      <p class="mb-1 text-xs font-medium text-muted">Chosen order</p>
      <ol class="flex flex-col gap-1">
        <li v-for="(item, position) in order" :key="item.index" class="flex items-center gap-2 text-sm">
          <span class="tabular-nums text-muted">{{ position + 1 }}.</span>
          <span class="flex-1">{{ item.option?.label }}</span>
          <button
            type="button"
            :class="button"
            :disabled="position === 0"
            :aria-label="`Move ${item.option?.label ?? ''} up`"
            @click="move(position, -1)"
          >
            Up
          </button>
          <button
            type="button"
            :class="button"
            :disabled="position === order.length - 1"
            :aria-label="`Move ${item.option?.label ?? ''} down`"
            @click="move(position, 1)"
          >
            Down
          </button>
        </li>
      </ol>
    </div>
    <p v-else class="text-xs text-muted">None chosen.</p>
  </div>
</template>
