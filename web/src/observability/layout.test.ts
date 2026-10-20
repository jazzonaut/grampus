// Checks actual ELK geometry, including reverse traffic and controller feedback loops.
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { graphFrame } from './graph';
import type { GraphEdge } from './graph';
import { graphGeometry, layoutInput, routedGraph } from './layout';
import type { RoutedGraph } from './layout';
import type { ElkPoint } from 'elkjs/lib/elk-api';

describe('orthogonal execution routing', () => {
  it('routes requests, responses and feedback without passing through unrelated participants', async () => {
    const nodes = graphFrame(
      [
        { id: 'controller', kind: 'controller', label: 'Controller', detail: '', status: 'observed' },
        { id: 'agent:a', kind: 'agent', label: 'Implementer', detail: '', status: 'active' },
        { id: 'agent:b', kind: 'agent', label: 'Reviewer', detail: '', status: 'completed' },
        { id: 'model:a', kind: 'model', label: 'Model A', detail: '', status: 'active' },
        { id: 'model:b', kind: 'model', label: 'Model B', detail: '', status: 'completed' },
        { id: 'tools:a', kind: 'tools', label: 'Workspace tools', detail: '', status: 'completed' },
        { id: 'check', kind: 'check', label: 'Validation', detail: '', status: 'completed' },
      ],
      [],
      true,
    ).nodes;
    const pairs = [
      ['controller', 'agent:a'],
      ['agent:a', 'controller'],
      ['controller', 'agent:b'],
      ['agent:b', 'controller'],
      ['agent:a', 'model:a'],
      ['model:a', 'agent:a'],
      ['agent:b', 'model:b'],
      ['model:b', 'agent:b'],
      ['agent:a', 'tools:a'],
      ['tools:a', 'agent:a'],
      ['controller', 'check'],
      ['check', 'controller'],
      ['controller', 'controller'],
    ];
    const edges: GraphEdge[] = pairs.map(([source, target], index) => ({
      id: String(index),
      source: source!,
      target: target!,
      event: null,
      count: 1,
      active: false,
    }));
    const elk = new ELK();
    const routed = routedGraph(await elk.layout(layoutInput(nodes, edges)));
    expect(routed.nodes.size).toBe(nodes.length);
    expect(routed.edges.size).toBe(edges.length);
    for (const edge of edges) checkEdge(routed, edge);
    expect(routed.edges.get('0')).not.toEqual(routed.edges.get('1'));
    // The bundled test engine runs in-process; production owns a real, terminable browser worker.
  });
});

const geometryTolerance = 1e-6;
function checkEdge(graph: RoutedGraph, edge: GraphEdge): void {
  for (const section of graph.edges.get(edge.id) ?? []) {
    for (let index = 1; index < section.length; index++) {
      const from = section[index - 1]!,
        to = section[index]!;
      expect(Math.abs(from.x - to.x) < geometryTolerance || Math.abs(from.y - to.y) < geometryTolerance).toBe(true);
      checkSegment(graph, edge, from, to);
    }
  }
}
function checkSegment(graph: RoutedGraph, edge: GraphEdge, from: ElkPoint, to: ElkPoint): void {
  for (const [id, box] of graph.nodes) {
    if (id === edge.source || id === edge.target) continue;
    const horizontal =
      Math.abs(from.y - to.y) < geometryTolerance &&
      from.y > box.y &&
      from.y < box.y + graphGeometry.nodeHeight &&
      Math.max(from.x, to.x) > box.x &&
      Math.min(from.x, to.x) < box.x + graphGeometry.nodeWidth;
    const vertical =
      Math.abs(from.x - to.x) < geometryTolerance &&
      from.x > box.x &&
      from.x < box.x + graphGeometry.nodeWidth &&
      Math.max(from.y, to.y) > box.y &&
      Math.min(from.y, to.y) < box.y + graphGeometry.nodeHeight;
    expect(horizontal || vertical, `${edge.id} crosses ${id}`).toBe(false);
  }
}
