<!--
  What the task waits for, pinned above the tabs: the decision with the evidence behind it, and any open
  worker questions. The actions themselves are in the default slot.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { TaskDetail } from '../../../src/dashboard/types';
import { shortSha } from '../presentation';
import CheckRun from './CheckRun.vue';
import RoundEvidence from './RoundEvidence.vue';

const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ show: [tab: string] }>();

const heading = computed(() => {
  const reason = props.task.needsYou?.reason ?? '';
  const [kind, value] = reason.split(':');
  switch (kind) {
    case 'approve-spec':
      return { icon: 'i-lucide-stamp', text: `Approve spec v${value}` };
    case 'ready':
      return { icon: 'i-lucide-circle-check', text: `Round ${value} passed everything` };
    case 'escalate':
      return { icon: 'i-lucide-hand', text: `Round ${value} needs your judgement` };
    default:
      return { icon: 'i-lucide-hand', text: 'Needs your decision' };
  }
});
const questions = computed(() => props.task.summary.questions.length);
/** The round awaiting accept, continue or abandon, with its evidence. */
const round = computed(() => props.task.rounds.find(entry => entry.round === props.task.summary.result?.round));
/** An escalation lists its reasons instead of the detail line, which repeats them in one run-on sentence. */
const escalated = computed(() => (round.value?.decision?.decision === 'escalate' ? round.value.decision : null));
/** The checks of the spec awaiting approval, run on the original commit. */
const specChecks = computed(() => {
  const checks = props.task.specChecks;
  return checks && checks.version === props.task.summary.approval?.version ? checks : null;
});
</script>

<template>
  <div
    v-if="task.needsYou || questions"
    class="rounded-xl border border-warning/50 bg-warning/5 p-4 space-y-3"
    role="region"
    aria-label="Needs you"
  >
    <template v-if="task.needsYou">
      <div class="flex items-start gap-3">
        <UIcon :name="heading.icon" class="size-5 text-warning shrink-0 mt-0.5" />
        <div class="min-w-0 space-y-1">
          <h3 class="font-semibold text-highlighted flex flex-wrap items-baseline gap-x-2">
            {{ heading.text }}
            <span v-if="round?.checks" class="font-mono text-xs font-normal text-dimmed">
              at {{ shortSha(round.checks.sha) }}
            </span>
          </h3>
          <ul v-if="escalated" class="text-sm list-disc pl-5 space-y-0.5">
            <li v-if="escalated.builderFailure">The builder reported failure; its report is below</li>
            <li v-for="reason in escalated.reasons" :key="reason" class="first-letter:uppercase">{{ reason }}</li>
          </ul>
          <p v-else class="text-sm text-muted whitespace-pre-line">{{ task.needsYou.detail }}</p>
        </div>
      </div>

      <div v-if="task.summary.approval" class="pl-8 space-y-1">
        <CheckRun v-if="specChecks" :task-id="task.taskId" :run="specChecks" title="Checks on the original commit" />
        <p v-if="specChecks?.results.some(result => !result.passed)" class="text-xs text-muted">
          A check should fail here only because the behaviour is missing. One that fails for another reason, such as no
          tests running or a missing tool, cannot pass after the build either.
        </p>
        <p v-if="!specChecks" class="text-sm text-muted flex items-center gap-1">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Running the checks on the original commit
        </p>
        <ul class="text-sm space-y-0.5">
          <li v-for="line in task.summary.approval.review" :key="line" class="text-muted">{{ line }}</li>
        </ul>
        <UButton size="sm" variant="link" icon="i-lucide-file-text" class="px-0" @click="emit('show', 'spec')">
          Read spec v{{ task.summary.approval.version }} before deciding
        </UButton>
      </div>

      <div v-if="round" class="pl-8 space-y-3">
        <RoundEvidence :task="task" :round="round" />
        <UButton size="sm" variant="link" icon="i-lucide-list-checks" class="px-0" @click="emit('show', 'rounds')">
          See every round and the baseline
        </UButton>
      </div>
    </template>

    <button
      v-if="questions"
      type="button"
      class="flex items-center gap-2 text-sm font-medium text-warning hover:underline"
      @click="emit('show', 'messages')"
    >
      <UIcon name="i-lucide-message-circle-question" class="size-5" />
      {{ questions === 1 ? 'A worker is asking you a question' : `${questions} worker questions are waiting` }}
    </button>

    <slot />
  </div>
</template>
