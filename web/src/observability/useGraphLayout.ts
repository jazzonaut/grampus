// Recalculates geometry only when topology changes. Status/token updates leave participant positions intact.
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { ELK } from 'elkjs/lib/elk-api';
import type { GraphEdge, GraphNode } from './graph';
import { graphGeometry, layoutInput, routedGraph } from './layout';
import type { RoutedGraph } from './layout';

/** Serialises topology updates, ignores stale layouts and terminates the local worker on unmount. */
export function useGraphLayout(nodes: () => GraphNode[], edges: () => GraphEdge[]) {
  const geometry = shallowRef<RoutedGraph>({
    width: graphGeometry.emptyWidth,
    height: graphGeometry.emptyHeight,
    nodes: new Map(),
    edges: new Map(),
  });
  const error = ref<string | null>(null);
  const arranging = ref(false);
  let engine: ELK | undefined;
  let disposed = false;
  let desired = '';
  let completed = '';
  const alive = (): boolean => !disposed;
  const topology = computed(() =>
    JSON.stringify({
      nodes: nodes()
        .map(node => [node.id, node.kind])
        .sort(),
      edges: edges()
        .map(edge => [edge.id, edge.source, edge.target])
        .sort(),
    }),
  );

  async function arrange(): Promise<void> {
    if (arranging.value || !alive()) return;
    if (!nodes().length) return;
    arranging.value = true;
    let requested = desired;
    try {
      engine ??= (await import('./layout-engine')).createLayoutEngine();
      if (!alive()) {
        engine.terminateWorker();
        return;
      }
      requested = desired;
      const graph = await engine.layout(layoutInput(nodes(), edges()));
      if (alive() && desired === requested) {
        geometry.value = routedGraph(graph);
        error.value = null;
      }
    } catch (failure) {
      if (alive() && desired === requested)
        error.value = failure instanceof Error ? failure.message : 'Layout unavailable';
    } finally {
      completed = requested;
      arranging.value = false;
      if (alive() && completed !== desired) void arrange();
    }
  }
  watch(
    topology,
    value => {
      desired = value;
      void arrange();
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    disposed = true;
    engine?.terminateWorker();
  });
  return { geometry, error, arranging };
}
