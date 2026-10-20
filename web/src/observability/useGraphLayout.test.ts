// Streaming must not reshuffle the network, and navigation must release its worker.
import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { graphFrame } from './graph';
import { useGraphLayout } from './useGraphLayout';

const worker = vi.hoisted(() => ({ layout: vi.fn<(graph: ElkNode) => Promise<ElkNode>>(), terminateWorker: vi.fn() }));
vi.mock('./layout-engine', () => ({ createLayoutEngine: () => worker }));

describe('graph layout lifecycle', () => {
  it('keeps geometry during telemetry updates and terminates the worker when the graph closes', async () => {
    worker.layout.mockResolvedValue({
      id: 'graph',
      width: 500,
      height: 200,
      children: [{ id: 'controller', x: 20, y: 30 }],
    });
    const nodes = ref(
      graphFrame(
        [{ id: 'controller', kind: 'controller', label: 'Controller', detail: '', status: 'observed' }],
        [],
        true,
      ).nodes,
    );
    const scope = effectScope();
    const layout = scope.run(() =>
      useGraphLayout(
        () => nodes.value,
        () => [],
      ),
    )!;
    await flushPromises();
    expect(worker.layout).toHaveBeenCalledTimes(1);
    const original = layout.geometry.value;
    nodes.value = nodes.value.map(node => ({ ...node, status: 'active', label: 'Updated live activity' }));
    await flushPromises();
    expect(worker.layout).toHaveBeenCalledTimes(1);
    expect(layout.geometry.value).toBe(original);
    scope.stop();
    expect(worker.terminateWorker).toHaveBeenCalledTimes(1);
  });
});
