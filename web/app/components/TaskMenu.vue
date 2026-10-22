<!--
  Task actions that are not pipeline decisions: Orca tabs, merge, abandon and remove. Orca actions act on
  the Orca window of the machine running Grampus, so they only help when you sit at that machine.
-->
<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';
import { useToast } from '@nuxt/ui/composables';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { TaskDetail } from '../../../src/dashboard/types';
import { sendJson } from '../api/client';
import { useCommands } from '../composables/useCommands';
import TextPrompt from './TextPrompt.vue';

const props = defineProps<{ task: TaskDetail }>();
const toast = useToast();
const { queue } = useCommands(() => props.task.taskId);
const abandoning = ref(false);
const confirmMerge = ref(false);
const confirmRemove = ref(false);
const removeWorktree = ref(true);
const router = useRouter();
const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

async function post(path: string, body: unknown, success: string): Promise<void> {
  try {
    await sendJson('POST', `/api/tasks/${encodeURIComponent(props.task.taskId)}/${path}`, body);
    toast.add({ title: success, icon: 'i-lucide-circle-check', color: 'success' });
  } catch (failure) {
    toast.add({
      title: 'That did not work',
      description: (failure as Error).message,
      icon: 'i-lucide-circle-x',
      color: 'error',
    });
  }
}

/** Like `grampus remove --force`: the dialog has said what goes, including uncommitted changes. */
async function remove(): Promise<void> {
  confirmRemove.value = false;
  const { taskId } = props.task;
  try {
    await sendJson('DELETE', `/api/tasks/${encodeURIComponent(taskId)}`, {
      worktree: removeWorktree.value,
      force: true,
    });
    toast.add({ title: `Removed ${taskId}`, icon: 'i-lucide-circle-check', color: 'success' });
    await router.push('/');
  } catch (failure) {
    toast.add({
      title: 'The task was not removed',
      description: (failure as Error).message,
      icon: 'i-lucide-circle-x',
      color: 'error',
    });
  }
}

/** Why the task cannot be removed now, if it cannot. */
const removeBlocked = computed(() => {
  if (props.task.comparisonId) return 'Comparison entries stay with their comparison';
  if (!props.task.finished && !props.task.lastStop) return 'Abandon it first';
  return undefined;
});

const items = computed<DropdownMenuItem[][]>(() => {
  const orcaHint = local ? undefined : 'Acts on the Orca window of the Grampus machine';
  const groups: DropdownMenuItem[][] = [
    [
      {
        label: 'Show driver terminal in Orca',
        icon: 'i-lucide-square-terminal',
        description: orcaHint,
        disabled: !props.task.worktree || props.task.finished !== null,
        onSelect: () => void post('open', { target: 'terminal' }, 'Driver terminal shown in Orca'),
      },
      {
        label: 'Open changed files in Orca',
        icon: 'i-lucide-file-diff',
        description: orcaHint,
        disabled: !props.task.worktree,
        onSelect: () => void post('open', { target: 'changes' }, 'Changed files opened in Orca'),
      },
    ],
  ];
  if (props.task.finished?.outcome === 'accepted' && !props.task.merged)
    groups.push([
      { label: 'Merge into my branch...', icon: 'i-lucide-git-merge', onSelect: () => (confirmMerge.value = true) },
    ]);
  const last: DropdownMenuItem[] = [];
  if (!props.task.finished)
    last.push({
      label: 'Abandon task...',
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => (abandoning.value = true),
    });
  last.push({
    label: 'Remove task...',
    icon: 'i-lucide-trash',
    color: 'error',
    description: removeBlocked.value,
    disabled: removeBlocked.value !== undefined,
    onSelect: () => {
      removeWorktree.value = props.task.worktree !== null;
      confirmRemove.value = true;
    },
  });
  groups.push(last);
  return groups;
});
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }">
    <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" aria-label="Task actions" />
  </UDropdownMenu>

  <TextPrompt
    v-model:open="abandoning"
    title="Abandon this task"
    description="Workers are released and nothing is merged. The worktree stays for you to look at."
    placeholder="Why? (optional, recorded with the task)"
    confirm="Abandon task"
    optional
    color="error"
    @submit="reason => queue(reason ? { kind: 'abandon', reason } : { kind: 'abandon' })"
  />

  <UModal
    v-model:open="confirmRemove"
    title="Remove this task?"
    description="Deletes its event log, specs, check logs and scorecard from Grampus. This cannot be undone."
  >
    <template #body>
      <div class="space-y-4">
        <UAlert
          v-if="!task.finished"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="This task has not finished"
          description="Its driver is not running. Workers it started are not stopped; remove it only when it cannot carry on."
        />
        <USwitch
          v-model="removeWorktree"
          :disabled="!task.worktree"
          label="Also remove its worktree"
          :description="
            task.worktree
              ? `${task.worktree.path}. Uncommitted changes in it are lost; Orca keeps the task branch unless it is merged.`
              : 'The task has no worktree.'
          "
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="confirmRemove = false" />
        <UButton icon="i-lucide-trash" color="error" label="Remove task" @click="remove" />
      </div>
    </template>
  </UModal>

  <UModal
    v-model:open="confirmMerge"
    title="Merge the verified commit?"
    description="Fast-forwards the branch checked out in the repository to the exact commit Grampus verified. Nothing is pushed. It refuses if your branch moved on or has uncommitted changes."
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="confirmMerge = false" />
        <UButton
          icon="i-lucide-git-merge"
          label="Merge"
          @click="
            confirmMerge = false;
            post('merge', {}, 'Merged. Nothing was pushed.');
          "
        />
      </div>
    </template>
  </UModal>
</template>
