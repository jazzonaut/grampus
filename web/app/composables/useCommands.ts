// Queueing decisions for a task's driver from the page, with a toast saying what happened. The driver
// applies a queued command within seconds; the live stream then shows the result.
import { useToast } from '@nuxt/ui/composables';
import { ref } from 'vue';
import type { CommandBody } from '../../../src/control';
import { sendJson } from '../api/client';

const verbs: Record<CommandBody['kind'], string> = {
  approve: 'Approval',
  revise: 'Revision request',
  reply: 'Answer',
  continue: 'Another round',
  retry: 'Retry',
  accept: 'Acceptance',
  abandon: 'Abandon',
  decline: 'Not selected',
};

export function useCommands(taskId: () => string) {
  const toast = useToast();
  const busy = ref<CommandBody['kind'] | null>(null);

  async function queue(body: CommandBody): Promise<boolean> {
    busy.value = body.kind;
    try {
      await sendJson('POST', `/api/tasks/${encodeURIComponent(taskId())}/commands`, body);
      toast.add({
        title: `${verbs[body.kind]} queued`,
        description: 'The task driver applies it within a few seconds.',
        icon: 'i-lucide-send',
        color: 'success',
      });
      return true;
    } catch (failure) {
      toast.add({
        title: 'Not queued',
        description: (failure as Error).message,
        icon: 'i-lucide-circle-x',
        color: 'error',
      });
      return false;
    } finally {
      busy.value = null;
    }
  }

  return { queue, busy };
}
