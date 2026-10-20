// Owns bounded activity polling and explicit historical windows. Reads pause during replay and while hidden.
import { computed, ref, shallowRef, watch } from 'vue';
import type {
  ActivityEventV1,
  ActivityNodeV1,
  ActivitySubjectV1,
  ObservabilityV1,
} from '../../../src/server/api-types';
import { get, needsAccessLink } from '../api/client';
import { usePolled } from '../api/usePolled';
import { clockTickMs } from '../settings';

/** Shared data access for the compact and expanded graph, with no overlapping polls or provider calls. */
export function useObservability(subject: () => ActivitySubjectV1) {
  const live = ref(true);
  const older = shallowRef<ActivityEventV1[]>([]);
  const historicalNodes = shallowRef<ActivityNodeV1[]>([]);
  const interval = ref(clockTickMs);
  const before = ref<string | null>(null);
  const historyError = ref<string | null>(null);
  const loadingHistory = ref(false);
  const path = () => {
    const { kind, id } = subject();
    return `/api/v1/${kind === 'task' ? 'tasks' : 'kickoffs'}/${id}/observability`;
  };
  const poll = usePolled(() => get<ObservabilityV1>(path()), interval, {
    enabled: () => live.value && !needsAccessLink.value,
  });
  const events = computed(() => {
    const unique = new Map([...older.value, ...(poll.data.value?.events ?? [])].map(event => [event.id, event]));
    return [...unique.values()].sort(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        (a.id.startsWith('task:') ? 1 : 0) - (b.id.startsWith('task:') ? 1 : 0) ||
        Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]),
    );
  });
  const nodes = computed(() => [
    ...new Map([...historicalNodes.value, ...(poll.data.value?.nodes ?? [])].map(node => [node.id, node])).values(),
  ]);
  watch(
    () => poll.data.value,
    value => {
      if (!older.value.length) before.value = value?.before ?? null;
      if (value) interval.value = value.intervalMs;
    },
  );

  async function loadOlder(): Promise<void> {
    if (!before.value || loadingHistory.value) return;
    live.value = false;
    loadingHistory.value = true;
    try {
      const page = await get<ObservabilityV1>(`${path()}?before=${encodeURIComponent(before.value)}`);
      older.value = [...page.events, ...older.value];
      historicalNodes.value = [
        ...new Map([...historicalNodes.value, ...page.nodes].map(node => [node.id, node])).values(),
      ];
      before.value = page.before;
      historyError.value = null;
    } catch (error) {
      historyError.value = error instanceof Error ? error.message : 'History unavailable';
    } finally {
      loadingHistory.value = false;
    }
  }
  return { poll, nodes, events, live, before, loadOlder, loadingHistory, historyError };
}
