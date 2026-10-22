<!-- Answer one worker question. The answer goes to the worker through the task driver. -->
<script setup lang="ts">
import { ref } from 'vue';
import type { MessageView } from '../../../src/dashboard/types';
import { useCommands } from '../composables/useCommands';

const props = defineProps<{ taskId: string; message: MessageView; queued: boolean }>();
const { queue, busy } = useCommands(() => props.taskId);
const answer = ref('');

async function send(): Promise<void> {
  if (!answer.value.trim()) return;
  if (await queue({ kind: 'reply', messageId: props.message.messageId, body: answer.value.trim() })) answer.value = '';
}
</script>

<template>
  <div class="flex gap-2 max-w-3xl ml-10">
    <p v-if="queued" class="text-sm text-muted flex items-center gap-1.5">
      <UIcon name="i-lucide-clock" class="size-4" /> Your answer is on its way to the worker.
    </p>
    <template v-else>
      <UTextarea
        v-model="answer"
        :rows="2"
        autoresize
        placeholder="Your answer"
        class="flex-1"
        @keydown.ctrl.enter="send"
        @keydown.meta.enter="send"
      />
      <UButton
        icon="i-lucide-send"
        label="Answer"
        :loading="busy === 'reply'"
        :disabled="!answer.trim()"
        class="self-end"
        @click="send"
      />
    </template>
  </div>
</template>
