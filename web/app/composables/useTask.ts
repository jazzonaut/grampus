// One task's detail, reloaded when its log or command queue changes.
import { onScopeDispose, ref, watch, type Ref } from 'vue';
import type { TaskDetail } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { useLive } from './useLive';

export function useTask(id: Ref<string>) {
  const task = ref<TaskDetail | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(false);

  async function refresh(): Promise<void> {
    const wanted = id.value;
    loading.value = true;
    try {
      const detail = await getJson<TaskDetail>(`/api/tasks/${encodeURIComponent(wanted)}`);
      // A slow answer for a task the user already left is dropped.
      if (wanted !== id.value) return;
      task.value = detail;
      error.value = null;
    } catch (failure) {
      if (wanted === id.value) error.value = (failure as Error).message;
    } finally {
      loading.value = false;
    }
  }

  watch(
    id,
    () => {
      task.value = null;
      void refresh();
    },
    { immediate: true },
  );
  const stop = useLive().onChange(changed => {
    if (changed === null || changed.includes(id.value)) void refresh();
  });
  onScopeDispose(stop);
  return { task, error, loading, refresh };
}
