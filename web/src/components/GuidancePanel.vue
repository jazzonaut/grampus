<script setup lang="ts">
/** Draws server-owned guidance actions and keeps a draft while the approved slice is unchanged. */
import { useTemplateRef } from 'vue';
import type { ActionView, GuidanceV1 } from '../../../src/server/api-types';
import type { FormDrafts } from '../api/actions';
import { useActions } from '../api/useActions';
import ActionForm from './ActionForm.vue';
import ActionButton from './ActionButton.vue';
import ActionNoticeBar from './ActionNoticeBar.vue';
import { localTime } from './format';

const props = defineProps<{ guidance: GuidanceV1; refresh: () => Promise<void> }>();
const composer = useTemplateRef<InstanceType<typeof ActionForm>>('composer');
const actions = useActions({
  refresh: () => props.refresh(),
  signature: () =>
    `${props.guidance.compose?.expected ?? ''}|${props.guidance.messages.map(message => `${message.id}:${message.status}`).join(',')}`,
  accepted: action => {
    if (action.id === 'queue-guidance') composer.value?.reset();
  },
});
function send(action: ActionView, drafts: FormDrafts = {}): void {
  void actions.run(action, drafts);
}
</script>

<template>
  <section
    v-if="guidance.compose || guidance.messages.length"
    class="flex flex-col gap-3 rounded-xl border border-default bg-default p-4"
    data-panel="guidance"
  >
    <h2 class="text-base font-semibold text-highlighted">Guide the next turn</h2>
    <p class="text-sm text-muted">
      Guidance waits for a matching agent turn. It cannot alter a turn already running or change the approved plan.
    </p>
    <ActionNoticeBar :notice="actions.notice.value" @dismiss="actions.dismiss()" />
    <details v-if="guidance.compose">
      <summary class="cursor-pointer text-sm font-medium text-highlighted">Add guidance</summary>
      <ActionForm
        ref="composer"
        class="mt-3"
        :action="guidance.compose"
        :draft-key="guidance.draftKey"
        :busy="actions.busy.value"
        :sending="actions.sending.value === 'queue-guidance'"
        :issues="actions.issuesFor('queue-guidance')"
        @submit="drafts => guidance.compose && send(guidance.compose, drafts)"
      />
    </details>
    <ol class="flex max-h-80 flex-col gap-3 overflow-y-auto" aria-label="Guidance history">
      <li
        v-for="message in guidance.messages"
        :key="message.id"
        class="flex flex-col gap-1 border-t border-default pt-3"
        :data-guidance="message.id"
      >
        <p class="text-xs text-muted">
          {{ message.targetLabel }} · {{ message.statusLabel }} · {{ localTime(message.at) }}
        </p>
        <p class="text-sm break-words whitespace-pre-wrap">{{ message.text }}</p>
        <p class="text-xs text-muted">{{ message.detail }}</p>
        <p class="text-xs text-muted">Plan version {{ message.version }} · slice {{ message.slice }}</p>
        <ActionButton
          v-if="message.cancel"
          :action="message.cancel"
          :busy="actions.busy.value"
          :sending="actions.sending.value === 'cancel-guidance'"
          @run="send(message.cancel)"
        />
      </li>
    </ol>
  </section>
</template>
