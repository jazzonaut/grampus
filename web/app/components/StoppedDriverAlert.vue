<!--
  A driver that stopped, or went missing without saying why, and a button that starts it again in a new
  Orca tab on the machine running Grampus. It continues where it stopped; the server refuses a second
  resume and closes the old tab only if Grampus opened it.
-->
<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables';
import { computed, ref } from 'vue';
import { sendJson } from '../api/client';
import { statusLook } from '../presentation';

const props = defineProps<{ title: string; reason: string; resumePath: string; command: string }>();
const toast = useToast();
/** Stays on after a resume: the alert goes once the new driver records its start. */
const resuming = ref(false);

async function resume(): Promise<void> {
  resuming.value = true;
  try {
    await sendJson('POST', props.resumePath, {});
    toast.add({ title: 'Driver resuming in a new Orca tab', icon: 'i-lucide-circle-check', color: 'success' });
  } catch (failure) {
    resuming.value = false;
    toast.add({
      title: 'Could not resume the driver',
      description: (failure as Error).message,
      icon: 'i-lucide-circle-x',
      color: 'error',
    });
  }
}

const actions = computed(() => [
  {
    label: 'Resume driver',
    icon: 'i-lucide-play',
    color: 'error' as const,
    variant: 'solid' as const,
    loading: resuming.value,
    onClick: () => void resume(),
  },
]);
</script>

<template>
  <UAlert
    color="error"
    variant="subtle"
    :icon="statusLook.stopped.icon"
    :title="title"
    :description="`${reason} Resume starts it again in a new Orca tab, or run ${command} in its tab yourself; either way it continues where it stopped.`"
    :actions="actions"
  />
</template>
