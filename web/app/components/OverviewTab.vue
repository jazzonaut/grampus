<!--
  Where the task stands: problems to know about, the decision it waits for, the request and what the spec
  says it changes, and your decisions, beside the workers that ran and the files changed. The two columns
  follow the panel's width, not the window's, since the task list beside it can be resized.
-->
<script setup lang="ts">
import type { TaskDetail } from '../../../src/dashboard/types';
import { computed } from 'vue';
import { duration, stepStateLook, when, type Look } from '../presentation';
import ChangesCard from './ChangesCard.vue';
import DecisionActions from './DecisionActions.vue';
import DecisionPanel from './DecisionPanel.vue';
import MarkdownView from './MarkdownView.vue';
import StatusIcon from './StatusIcon.vue';
import StoppedDriverAlert from './StoppedDriverAlert.vue';

const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ show: [tab: string] }>();

/** The approved spec, or the latest version while none is. */
const spec = computed(() => props.task.specs.find(entry => entry.approved) ?? props.task.specs.at(-1));

function dispatchLook(dispatch: TaskDetail['stages'][number]['dispatches'][number]): Look {
  if (dispatch.settled) return dispatch.settled.outcome === 'succeeded' ? stepStateLook.done : stepStateLook.failed;
  return dispatch.exited ? { icon: 'i-lucide-bot-off', color: 'error', label: 'Exited' } : stepStateLook.running;
}

function took(dispatch: TaskDetail['stages'][number]['dispatches'][number]): string {
  return dispatch.settled ? duration(Date.parse(dispatch.settled.at) - Date.parse(dispatch.requestedAt)) : '';
}

const commandIcon = {
  approve: 'i-lucide-stamp',
  revise: 'i-lucide-pencil',
  reply: 'i-lucide-reply',
  continue: 'i-lucide-redo-2',
  retry: 'i-lucide-rotate-ccw',
  accept: 'i-lucide-check-check',
  abandon: 'i-lucide-trash-2',
  decline: 'i-lucide-circle-slash',
  explain: 'i-lucide-book-open',
  ask: 'i-lucide-message-circle-question',
} as const;
const commandState = {
  queued: { icon: 'i-lucide-clock', color: 'neutral', label: 'Queued for the driver' },
  applied: { icon: 'i-lucide-circle-check', color: 'success', label: 'Applied' },
  refused: { icon: 'i-lucide-circle-x', color: 'error', label: 'Refused' },
} as const satisfies Record<string, Look>;
</script>

<template>
  <div class="@container space-y-4">
    <StoppedDriverAlert
      v-if="task.lastStop"
      title="The driver stopped"
      :reason="task.lastStop.reason"
      :resume-path="`/api/tasks/${encodeURIComponent(task.taskId)}/resume`"
      :command="`grampus drive ${task.taskId}`"
    />
    <UAlert
      v-if="task.summary.refused"
      color="warning"
      variant="subtle"
      icon="i-lucide-user-x"
      :title="`Your ${task.summary.refused.kind} was refused`"
      :description="task.summary.refused.reason"
    />
    <UAlert
      v-if="task.finished?.override"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Accepted with unresolved problems"
      description="You accepted this task after it escalated; its last round did not pass everything."
    />
    <UAlert
      v-if="task.merged"
      color="success"
      variant="subtle"
      icon="i-lucide-git-merge"
      :title="`Merged into ${task.merged.branch}`"
      :description="`Fast-forwarded to ${task.merged.sha.slice(0, 12)}. Nothing was pushed.`"
    />

    <div class="grid gap-4 items-start @4xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <div class="space-y-4 min-w-0">
        <DecisionPanel :task="task" @show="value => emit('show', value)">
          <DecisionActions :task="task" />
        </DecisionPanel>

        <UCard>
          <template #header>
            <h3 class="font-semibold flex items-center gap-2">
              <UIcon name="i-lucide-message-square-quote" class="size-4" /> Request
            </h3>
          </template>
          <MarkdownView :source="task.request" />
        </UCard>

        <UCard v-if="spec?.outcome">
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-semibold flex items-center gap-2">
                <UIcon name="i-lucide-notebook-text" class="size-4" /> Description
              </h3>
              <UButton
                size="xs"
                variant="link"
                color="neutral"
                trailing-icon="i-lucide-arrow-right"
                class="px-0"
                @click="emit('show', 'spec')"
              >
                From spec v{{ spec.version }}
              </UButton>
            </div>
          </template>
          <MarkdownView :source="spec.outcome" />
        </UCard>

        <UCard v-if="task.commands.length">
          <template #header>
            <h3 class="font-semibold flex items-center gap-2">
              <UIcon name="i-lucide-user-check" class="size-4" /> Your decisions
            </h3>
          </template>
          <ul class="space-y-2">
            <li v-for="command in task.commands" :key="command.id" class="flex items-start gap-3">
              <UIcon :name="commandIcon[command.kind]" class="size-4 mt-0.5 text-muted shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="text-sm">
                  <span class="font-medium">{{ command.kind }}</span>
                  <span class="text-muted"> from {{ command.source }}, {{ when(command.at) }}</span>
                </p>
                <p v-if="command.text" class="text-sm text-muted line-clamp-3 whitespace-pre-line">
                  {{ command.text }}
                </p>
                <p v-if="command.reason" class="text-sm text-error">{{ command.reason }}</p>
              </div>
              <UTooltip :text="commandState[command.state].label">
                <StatusIcon :look="commandState[command.state]" size="size-4" />
              </UTooltip>
            </li>
          </ul>
        </UCard>
      </div>

      <div class="space-y-4 min-w-0">
        <UCard v-if="task.stages.length">
          <template #header>
            <h3 class="font-semibold flex items-center gap-2"><UIcon name="i-lucide-bot" class="size-4" /> Workers</h3>
          </template>
          <ul class="divide-y divide-default -my-2">
            <template v-for="stage in task.stages" :key="stage.key">
              <li v-if="stage.startFailure" class="flex items-center gap-3 py-2">
                <StatusIcon :look="stepStateLook.failed" size="size-4" />
                <span class="font-mono text-sm">{{ stage.key }}</span>
                <span class="text-sm text-error truncate">failed to start: {{ stage.startFailure.error }}</span>
              </li>
              <li v-for="dispatch in stage.dispatches" :key="dispatch.dispatchId" class="flex gap-3 py-2">
                <StatusIcon :look="dispatchLook(dispatch)" size="size-4" class="mt-0.5" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span class="font-mono text-sm">{{ stage.key }}</span>
                    <UBadge v-if="dispatch.reused" size="sm" variant="subtle" color="neutral" icon="i-lucide-link"
                      >continued</UBadge
                    >
                    <span class="ml-auto shrink-0 text-xs text-dimmed">{{ took(dispatch) }}</span>
                  </div>
                  <p class="text-xs text-muted truncate">
                    {{
                      [dispatch.agent, dispatch.model, dispatch.effort].filter(Boolean).join(' · ') || 'default agent'
                    }}
                  </p>
                  <p v-if="dispatch.settled?.subject" class="mt-0.5 text-sm text-muted">
                    {{ dispatch.settled.subject }}
                  </p>
                </div>
              </li>
            </template>
          </ul>
        </UCard>

        <ChangesCard
          v-if="task.worktree"
          :task-id="task.taskId"
          :updated-at="task.updatedAt"
          @show="value => emit('show', value)"
        />
      </div>
    </div>
  </div>
</template>
