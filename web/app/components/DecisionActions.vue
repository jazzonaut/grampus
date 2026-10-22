<!--
  The buttons for the decision a task waits for. Only the options the driver offers are shown, and the
  ones that need words ask for them first.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TaskDetail } from '../../../src/dashboard/types';
import { useCommands } from '../composables/useCommands';
import TextPrompt from './TextPrompt.vue';

const props = defineProps<{ task: TaskDetail }>();
const { queue, busy } = useCommands(() => props.task.taskId);

const options = computed(() => new Set(props.task.needsYou?.options ?? []));
const latestSpec = computed(() => props.task.specs.at(-1)?.version ?? null);
const escalated = computed(() => props.task.needsYou?.reason.startsWith('escalate:') ?? false);
/** Tests first produced nothing: `continue` here builds without tests, it does not run a repair round. */
const withoutTests = computed(() => props.task.needsYou?.reason === 'tests-failed');
const queuedKinds = computed(
  () => new Set(props.task.commands.filter(command => command.state === 'queued').map(command => command.kind)),
);

type Prompted = 'revise' | 'continue' | 'abandon';
const prompt = ref<Prompted | null>(null);
const promptOpen = computed({
  get: () => prompt.value !== null,
  set: value => {
    if (!value) prompt.value = null;
  },
});
interface PromptText {
  title: string;
  description: string;
  placeholder: string;
  confirm: string;
  optional?: boolean;
  color?: 'error';
}
const prompts: Record<Prompted, PromptText> = {
  revise: {
    title: 'Ask for a revision',
    description: 'The spec writer revises the spec with your feedback. You approve the new version.',
    placeholder: 'What should change in the spec?',
    confirm: 'Send feedback',
  },
  continue: {
    title: 'Run another round',
    description: 'A repair worker gets your guidance plus the evidence of this round.',
    placeholder: 'What should the next round do differently?',
    confirm: 'Run another round',
  },
  abandon: {
    title: 'Abandon this task',
    description: 'Workers are released and nothing is merged. The worktree stays for you to look at.',
    placeholder: 'Why? (optional, recorded with the task)',
    confirm: 'Abandon task',
    optional: true,
    color: 'error',
  },
};
const buildWithoutTests: PromptText = {
  title: 'Build without tests',
  description:
    'The builder starts from the approved spec with no tests written first. The checks and the review still run. Your note goes to every later repair round.',
  placeholder: 'A note for later repair rounds, e.g. no tests were written first; rely on the spec checks',
  confirm: 'Build without tests',
};
const promptText = computed(() =>
  prompt.value === 'continue' && withoutTests.value ? buildWithoutTests : prompt.value ? prompts[prompt.value] : null,
);

function submitPrompt(text: string): void {
  const kind = prompt.value;
  if (kind === 'revise') void queue({ kind: 'revise', feedback: text });
  if (kind === 'continue') void queue({ kind: 'continue', guidance: text });
  if (kind === 'abandon') void queue(text ? { kind: 'abandon', reason: text } : { kind: 'abandon' });
}

/** What has not landed for the spec awaiting approval; approving now goes without it. */
const stillRunning = computed(() => props.task.summary.approval?.running ?? []);
const confirmApprove = ref(false);

function approve(): void {
  if (stillRunning.value.length && !confirmApprove.value) {
    confirmApprove.value = true;
    return;
  }
  confirmApprove.value = false;
  if (latestSpec.value !== null) void queue({ kind: 'approve', specVersion: latestSpec.value });
}
</script>

<template>
  <div v-if="task.needsYou" class="flex flex-wrap items-center gap-2 pl-8">
    <UButton
      v-if="options.has('approve') && latestSpec !== null"
      icon="i-lucide-stamp"
      :label="`Approve v${latestSpec}`"
      :loading="busy === 'approve'"
      :disabled="queuedKinds.has('approve')"
      @click="approve"
    />
    <UButton
      v-if="options.has('accept') && task.comparisonId"
      icon="i-lucide-trophy"
      color="neutral"
      variant="outline"
      label="Compare and pick"
      :to="{ name: 'comparison', params: { id: task.comparisonId } }"
    />
    <UButton
      v-if="options.has('accept') && !task.comparisonId"
      icon="i-lucide-check-check"
      :color="escalated ? 'warning' : 'primary'"
      :label="escalated ? 'Accept anyway' : 'Accept'"
      :loading="busy === 'accept'"
      :disabled="queuedKinds.has('accept')"
      @click="queue({ kind: 'accept' })"
    />
    <UButton
      v-if="options.has('revise')"
      icon="i-lucide-pencil"
      color="neutral"
      variant="outline"
      label="Ask for a revision"
      @click="prompt = 'revise'"
    />
    <UButton
      v-if="options.has('continue')"
      :icon="withoutTests ? 'i-lucide-skip-forward' : 'i-lucide-redo-2'"
      color="neutral"
      variant="outline"
      :label="withoutTests ? 'Build without tests' : 'Another round'"
      @click="prompt = 'continue'"
    />
    <UButton
      v-if="options.has('retry')"
      icon="i-lucide-rotate-ccw"
      color="neutral"
      variant="outline"
      label="Retry"
      :loading="busy === 'retry'"
      @click="queue({ kind: 'retry' })"
    />
    <UButton
      v-if="options.has('abandon')"
      icon="i-lucide-trash-2"
      color="error"
      variant="ghost"
      label="Abandon"
      @click="prompt = 'abandon'"
    />
    <span v-if="queuedKinds.size" class="text-xs text-muted flex items-center gap-1">
      <UIcon name="i-lucide-clock" class="size-3.5" /> Waiting for the driver to apply your decision
    </span>
    <p v-if="escalated && options.has('accept')" class="basis-full text-xs text-warning">
      Accepting now is recorded as an override: this round did not pass everything.
    </p>

    <TextPrompt v-if="promptText" v-model:open="promptOpen" v-bind="promptText" @submit="submitPrompt" />
    <UModal
      v-model:open="confirmApprove"
      :title="`Approve v${latestSpec} before the ${stillRunning.join(' and ')} finish?`"
      description="You would be approving without their results."
    >
      <template #body>
        <ul class="text-sm list-disc pl-5 space-y-1">
          <li v-if="stillRunning.includes('spec review')">
            The spec review stops, so you will not see what it finds about the spec or its checks.
          </li>
          <li v-if="stillRunning.includes('checks')">
            The checks still finish before the build starts, but you will not see which ones fail before the change.
          </li>
        </ul>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Wait for them" @click="confirmApprove = false" />
          <UButton color="warning" icon="i-lucide-stamp" label="Approve anyway" @click="approve" />
        </div>
      </template>
    </UModal>
  </div>
</template>
