// Folds server-decided display updates for live viewing and replay. It never infers workflow success.
import type { ActivityEventV1, ActivityNodeV1 } from '../../../src/server/api-types';

/** A directed relationship, retaining the event that last changed its appearance. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  event: ActivityEventV1 | null;
  count: number;
  active: boolean;
}

/** Last visible observations used in hover details, always restricted to the replay prefix. */
export interface GraphNode extends ActivityNodeV1 {
  activity: ActivityEventV1 | null;
  usage: ActivityEventV1['usage'];
}

/** A prefix of the loaded activity window. Replay starts unknown and never reads current node states. */
export function graphFrame(nodes: readonly ActivityNodeV1[], events: readonly ActivityEventV1[], live: boolean) {
  const participants = new Map<string, GraphNode>(
    nodes.map(node => [node.id, { ...node, status: live ? node.status : 'unknown', activity: null, usage: null }]),
  );
  const visible = new Set<string>(live ? nodes.filter(node => node.recorded !== false).map(node => node.id) : []);
  const edges = new Map<string, GraphEdge>();
  const active = new Map<string, Set<string>>();
  for (const event of events) {
    visible.add(event.source);
    visible.add(event.target);
    applyUpdates(participants, active, event);
    describeActivity(participants, event);
    const id = `${event.source}>${event.target}`;
    edges.set(id, {
      id,
      source: event.source,
      target: event.target,
      event,
      count: (edges.get(id)?.count ?? 0) + 1,
      active: false,
    });
  }
  for (const edge of edges.values()) edge.active = activeEdge(edge, participants);
  if (live) seedConnections(nodes, visible, edges);
  return { nodes: [...participants.values()].filter(node => visible.has(node.id)), edges: [...edges.values()] };
}

function describeActivity(nodes: Map<string, GraphNode>, event: ActivityEventV1): void {
  for (const id of new Set([event.source, event.target])) {
    const node = nodes.get(id);
    if (!node) continue;
    node.activity = event;
    if (event.usage) node.usage = event.usage;
  }
}

function activeEdge(edge: GraphEdge, nodes: Map<string, ActivityNodeV1>): boolean {
  return (
    edge.event?.status === 'active' &&
    edge.event.updates.some(update => update.status === 'active' && nodes.get(update.nodeId)?.status === 'active')
  );
}

function seedConnections(nodes: readonly ActivityNodeV1[], visible: Set<string>, edges: Map<string, GraphEdge>): void {
  for (const node of nodes) {
    if (!node.parentId || !visible.has(node.id)) continue;
    const id = `${node.parentId}>${node.id}`;
    if (!edges.has(id))
      edges.set(id, { id, source: node.parentId, target: node.id, event: null, count: 0, active: false });
  }
}

function applyUpdates(
  nodes: Map<string, ActivityNodeV1>,
  active: Map<string, Set<string>>,
  event: ActivityEventV1,
): void {
  for (const update of event.updates) {
    const node = nodes.get(update.nodeId);
    if (!node || (update.onlyIfActive && node.status !== 'active')) continue;
    if (update.label) node.label = update.label;
    const items = active.get(node.id) ?? new Set<string>();
    const itemId = event.correlation.itemId;
    if (itemId && update.status === 'active') items.add(itemId);
    else if (itemId) items.delete(itemId);
    else if (update.status !== 'active') items.clear();
    active.set(node.id, items);
    node.status = items.size ? 'active' : update.status;
  }
}

/** Latest reported counters per session. Cumulative snapshots are replaced rather than added together. */
export function usageSnapshots(events: readonly ActivityEventV1[]) {
  const sessions = new Map<string, NonNullable<ActivityEventV1['usage']>>();
  for (const event of events) {
    if (event.usage && event.correlation.sessionId) {
      const key = `${event.correlation.provider ?? ''}:${event.correlation.providerSessionId ?? event.correlation.sessionId}`;
      sessions.set(key, event.usage);
    }
  }
  return [...sessions.values()];
}

/** Groups the server's compact participant identities without discarding completed sessions. */
export function compactGraph(frame: ReturnType<typeof graphFrame>): ReturnType<typeof graphFrame> {
  const ids = new Map(frame.nodes.map(node => [node.id, node.groupId ?? node.id]));
  const nodes = new Map<string, GraphNode>();
  for (const node of frame.nodes) {
    const id = ids.get(node.id) ?? node.id;
    const previous = nodes.get(id);
    const status = previous?.status === 'active' ? 'active' : node.status;
    nodes.set(id, { ...node, id, label: node.groupLabel ?? node.label, status });
  }
  const edges = new Map<string, GraphEdge>();
  for (const edge of frame.edges) {
    const source = ids.get(edge.source) ?? edge.source,
      target = ids.get(edge.target) ?? edge.target;
    const id = `${source}>${target}`;
    edges.set(id, {
      ...edge,
      id,
      source,
      target,
      count: edge.count + (edges.get(id)?.count ?? 0),
      active: edge.active || (edges.get(id)?.active ?? false),
    });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
