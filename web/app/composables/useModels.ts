// Models and effort levels per agent, asked of the agent CLIs once and shared by every recipe editor.
import { ref } from 'vue';
import type { AgentCatalog } from '../../../src/agents/catalog';
import { getJson } from '../api/client';

const catalogs = ref<AgentCatalog[]>([]);
const loading = ref(false);
let requested = false;

async function load(refresh: boolean): Promise<void> {
  loading.value = true;
  try {
    catalogs.value = (await getJson<{ agents: AgentCatalog[] }>(`/api/models${refresh ? '?refresh' : ''}`)).agents;
  } finally {
    loading.value = false;
  }
}

export function useModels() {
  if (!requested) {
    requested = true;
    void load(false);
  }
  return { catalogs, loading, refresh: () => load(true) };
}
