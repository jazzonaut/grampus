<!-- A modal asking for a piece of text (feedback, guidance, a reason) before a decision is queued. -->
<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
  title: string;
  description: string;
  placeholder: string;
  confirm: string;
  /** Allow sending without text, as abandon does. */
  optional?: boolean;
  color?: 'primary' | 'error' | 'warning';
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ submit: [text: string] }>();

const text = ref('');
watch(open, value => {
  if (value) text.value = '';
});

function submit(): void {
  if (!props.optional && !text.value.trim()) return;
  emit('submit', text.value.trim());
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description">
    <template #body>
      <UTextarea
        v-model="text"
        :placeholder="placeholder"
        :rows="6"
        autoresize
        autofocus
        class="w-full"
        @keydown.ctrl.enter="submit"
        @keydown.meta.enter="submit"
      />
      <p class="mt-1 text-xs text-dimmed">Ctrl+Enter to send. Markdown is fine.</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton :color="color ?? 'primary'" :label="confirm" :disabled="!optional && !text.trim()" @click="submit" />
      </div>
    </template>
  </UModal>
</template>
