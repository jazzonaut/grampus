// Owns graph geometry through ELK, keeping telemetry interpretation and visual routing independent.
import type { ElkNode, ElkExtendedEdge, ElkPoint } from 'elkjs/lib/elk-api';
import type { GraphEdge, GraphNode } from './graph';

/** Shared visual dimensions; these do not impose workflow or evidence bounds. */
export const graphGeometry = { nodeWidth: 198, nodeHeight: 82, emptyWidth: 500, emptyHeight: 160 } as const;

/** Routed geometry, keyed by stable participant/relationship identities. */
export interface RoutedGraph {
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number }>;
  edges: Map<string, ElkPoint[][]>;
}

function tier(node: GraphNode): number {
  if (node.kind === 'controller') return 0;
  return node.kind === 'model' || node.kind === 'tools' ? 2 : 1;
}

/** Builds a deterministic port graph; reverse traffic has its own ports and orthogonal route. */
export function layoutInput(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): ElkNode {
  const ordered = [...nodes].sort((a, b) => tier(a) - tier(b) || a.id.localeCompare(b.id));
  const children: ElkNode[] = ordered.map(node => ({
    id: node.id,
    width: graphGeometry.nodeWidth,
    height: graphGeometry.nodeHeight,
    ports: [],
    layoutOptions: {
      'elk.portConstraints': 'FIXED_ORDER',
      ...(node.kind === 'controller' ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
      ...(node.kind === 'model' || node.kind === 'tools' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : {}),
    },
  }));
  const participants = new Map(ordered.map(node => [node.id, node]));
  const boxes = new Map(children.map(node => [node.id, node]));
  const routed: ElkExtendedEdge[] = [];
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const from = participants.get(edge.source),
      to = participants.get(edge.target);
    if (!from || !to) continue;
    const forward = tier(from) < tier(to);
    const sourcePort = `port:source:${edge.id}`,
      targetPort = `port:target:${edge.id}`;
    const sourceSide = edge.source === edge.target ? 'NORTH' : forward ? 'EAST' : 'WEST';
    const targetSide = edge.source === edge.target ? 'NORTH' : forward ? 'WEST' : 'EAST';
    boxes
      .get(edge.source)
      ?.ports?.push({ id: sourcePort, width: 1, height: 1, layoutOptions: { 'elk.port.side': sourceSide } });
    boxes
      .get(edge.target)
      ?.ports?.push({ id: targetPort, width: 1, height: 1, layoutOptions: { 'elk.port.side': targetSide } });
    routed.push({ id: edge.id, sources: [sourcePort], targets: [targetPort] });
  }
  return {
    id: 'execution-network',
    children,
    edges: routed,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      'elk.spacing.nodeNode': '32',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '12',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.randomSeed': '1',
    },
  };
}

/** Keeps ELK's bend points rather than replacing its routing with hand-drawn curves. */
export function routedGraph(graph: ElkNode): RoutedGraph {
  const nodes = new Map<string, { x: number; y: number }>();
  for (const node of graph.children ?? []) {
    if (node.x === undefined || node.y === undefined) throw new Error('Graph layout did not place a participant');
    nodes.set(node.id, { x: node.x, y: node.y });
  }
  const edges = new Map<string, ElkPoint[][]>();
  for (const edge of graph.edges ?? []) {
    if (!edge.sections?.length) throw new Error('Graph layout did not route a connection');
    edges.set(
      edge.id,
      edge.sections.map(section => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]),
    );
  }
  return {
    width: graph.width ?? graphGeometry.emptyWidth,
    height: graph.height ?? graphGeometry.emptyHeight,
    nodes,
    edges,
  };
}

/** Orthogonal segments rendered directly as an SVG path, without crossing node interiors. */
export function routePath(sections: readonly ElkPoint[][]): string {
  return sections
    .map(points => points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '))
    .join(' ');
}
