// System health, shared by the sidebar badge, the alerts and the System page. It reloads when any log
// changes (a driver stopping changes its task's signature) and on the server's interval, since Orca going
// down or an agent nearing its limit changes no log.
import { ref } from 'vue';
import type { HealthView } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { useLive } from './useLive';

const health = ref<HealthView | null>(null);
const error = ref<string | null>(null);
let started = false;
let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Until the server has said how often to ask. */
const fallbackRefreshMs = 30_000;

/** One request at a time: changes that arrive meanwhile cause one more reload, not one each. */
async function refresh(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  clearTimeout(timer);
  try {
    health.value = await getJson<HealthView>('/api/health');
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    running = false;
    timer = setTimeout(() => void refresh(), health.value?.refreshMs ?? fallbackRefreshMs);
    if (again) {
      again = false;
      void refresh();
    }
  }
}

export function useHealth() {
  if (!started) {
    started = true;
    void refresh();
    useLive().onChange(() => void refresh());
  }
  return { health, error, refresh };
}
