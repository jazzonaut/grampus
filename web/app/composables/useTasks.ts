// The task list, shared by the sidebar, the list panel and the tab badge. It reloads whenever any task log
// changes, so every view shows the same moment.
import { computed, ref } from 'vue';
import type { TaskList, TaskListItem } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { useLive } from './useLive';

const tasks = ref<TaskListItem[]>([]);
const unreadable = ref<TaskList['unreadable']>([]);
const loaded = ref(false);
const error = ref<string | null>(null);
let started = false;

async function refresh(): Promise<void> {
  try {
    const list = await getJson<TaskList>('/api/tasks');
    tasks.value = list.tasks;
    unreadable.value = list.unreadable;
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    loaded.value = true;
  }
}

export function useTasks() {
  if (!started) {
    started = true;
    void refresh();
    useLive().onChange(() => void refresh());
  }
  return {
    tasks,
    unreadable,
    loaded,
    error,
    refresh,
    needsYou: computed(() => tasks.value.filter(task => task.status === 'needs-you')),
  };
}
