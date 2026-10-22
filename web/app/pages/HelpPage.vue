<!--
  Help: how a task moves through the pipeline, what the icons mean, and every command. The command list
  comes from the same catalog as `grampus --help`.
-->
<script setup lang="ts">
import { ref } from 'vue';
import type { HelpView, StepId, StepState, TaskStatus } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import StatusIcon from '../components/StatusIcon.vue';
import { statusLook, stepIcon, stepStateLook } from '../presentation';

const help = ref<HelpView | null>(null);
const error = ref<string | null>(null);
getJson<HelpView>('/api/help').then(
  value => (help.value = value),
  (failure: unknown) => (error.value = (failure as Error).message),
);

const steps: { id: StepId; label: string; text: string }[] = [
  {
    id: 'spec',
    label: 'Spec',
    text: 'A worker studies the repository, asks you about real ambiguities and writes a spec with checks.',
  },
  {
    id: 'spec-review',
    label: 'Spec review',
    text: 'A model from the other family reviews the spec while you read it. Its findings are shown, never looped.',
  },
  {
    id: 'approve',
    label: 'Approve',
    text: 'Nothing is built until you approve this exact spec version, or ask for a revision.',
  },
  {
    id: 'tests',
    label: 'Tests first',
    text: 'Optional: a worker turns the spec examples into failing tests, which become protected.',
  },
  {
    id: 'baseline',
    label: 'Baseline',
    text: 'Grampus runs the checks before the change, so earlier failures are known.',
  },
  { id: 'build', label: 'Build', text: 'A worker implements the spec in the task worktree and commits.' },
  {
    id: 'verify',
    label: 'Verify',
    text: 'Grampus itself checks the tree, guards protected files and tests, and runs every check at the commit.',
  },
  {
    id: 'review',
    label: 'Review',
    text: 'The other model family reviews the change. Only findings with a location and a failing scenario block.',
  },
  {
    id: 'repair',
    label: 'Repair',
    text: 'Failures go back to a repair worker, for a bounded number of rounds, then to you.',
  },
  {
    id: 'accept',
    label: 'Accept',
    text: 'You accept the verified commit, ask for another round, or abandon. Merge is a separate, opt-in step.',
  },
];
const statuses = Object.keys(statusLook) as TaskStatus[];
const states = Object.keys(stepStateLook) as StepState[];
</script>

<template>
  <UDashboardPanel id="help">
    <template #header>
      <UDashboardNavbar title="Help" icon="i-lucide-circle-help">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-4xl space-y-8">
        <section class="space-y-3">
          <h2 class="text-lg font-semibold">How a task runs</h2>
          <p class="text-sm text-muted">
            Grampus turns a request into a verified commit. It never takes an agent's word for it: it runs the checks
            itself against the exact commit and has the other model family review the change. It only asks you for
            decisions.
          </p>
          <ol class="grid gap-2 sm:grid-cols-2">
            <li v-for="step in steps" :key="step.id" class="flex gap-3 rounded-lg border border-default p-3">
              <UIcon :name="stepIcon[step.id]" class="size-5 shrink-0 text-primary mt-0.5" />
              <div>
                <p class="font-medium text-sm">{{ step.label }}</p>
                <p class="text-sm text-muted">{{ step.text }}</p>
              </div>
            </li>
          </ol>
        </section>

        <section class="grid gap-6 sm:grid-cols-2">
          <div class="space-y-2">
            <h2 class="text-lg font-semibold">Task status</h2>
            <ul class="space-y-1.5">
              <li v-for="status in statuses" :key="status" class="flex items-center gap-2 text-sm">
                <StatusIcon :look="statusLook[status]" /> {{ statusLook[status].label }}
              </li>
            </ul>
          </div>
          <div class="space-y-2">
            <h2 class="text-lg font-semibold">Pipeline steps</h2>
            <ul class="space-y-1.5">
              <li v-for="state in states" :key="state" class="flex items-center gap-2 text-sm">
                <StatusIcon :look="stepStateLook[state]" /> {{ stepStateLook[state].label }}
              </li>
            </ul>
          </div>
        </section>

        <section class="space-y-4">
          <h2 class="text-lg font-semibold">Commands</h2>
          <p class="text-sm text-muted">
            Everything the dashboard does is also a <code class="font-mono">grampus</code> command, so a chat agent with
            the Grampus skill can do it too. Decisions are queued for the task's driver, which applies them within a few
            seconds.
          </p>
          <UAlert v-if="error" color="error" variant="subtle" :title="error" />
          <div v-for="group in help?.groups ?? []" :key="group.id" class="space-y-2">
            <h3 class="font-medium">{{ group.title }}</h3>
            <div class="divide-y divide-default rounded-lg border border-default">
              <div v-for="command in group.commands" :key="command.name" class="px-3 py-2.5">
                <p class="font-mono text-sm break-words">
                  <span class="text-primary font-semibold">grampus {{ command.name }}</span>
                  <span class="text-muted"> {{ command.args }}</span>
                </p>
                <p class="text-sm">{{ command.summary }}</p>
                <p v-if="command.detail" class="text-sm text-muted">{{ command.detail }}</p>
              </div>
            </div>
          </div>
          <p v-if="help" class="text-sm text-muted">
            Every command also takes: <span class="font-mono">{{ help.globalOptions }}</span>
          </p>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
