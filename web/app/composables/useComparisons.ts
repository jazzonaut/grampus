// The comparison list, shared by the sidebar badge and the comparisons page, reloaded when any
// comparison log changes.
import { computed, ref } from 'vue';
import type { ComparisonListItem } from '../../../src/dashboard/types';
import { getJson } from '../api/client';
import { useLive } from './useLive';

const comparisons = ref<ComparisonListItem[]>([]);
const loaded = ref(false);
const error = ref<string | null>(null);
let started = false;

async function refresh(): Promise<void> {
  try {
    comparisons.value = (await getJson<{ comparisons: ComparisonListItem[] }>('/api/comparisons')).comparisons;
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    loaded.value = true;
  }
}

export function useComparisons() {
  if (!started) {
    started = true;
    void refresh();
    useLive().onChange(changed => {
      if (changed === null || changed.some(id => id.startsWith('cmp:'))) void refresh();
    });
  }
  return {
    comparisons,
    loaded,
    error,
    refresh,
    needsYou: computed(() => comparisons.value.filter(item => item.status === 'needs-you')),
  };
}
