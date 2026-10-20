// Folds server-decided display updates for live viewing and replay. It never infers workflow success.
import type { ActivityEventV1, ActivityNodeV1 } from '../../../src/server/api-types';

/** A directed relationship, retaining its unfinished operation or latest settled observation. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  event: ActivityEventV1 | null;
  count: number;
  active: boolean;
}

/** Current unfinished or latest visible observations, always restricted to the replay prefix. */
export interface GraphNode extends ActivityNodeV1 {
  activity: ActivityEventV1 | null;
  usage: ActivityEventV1['usage'];
}

type PendingActivity = Map<string, Map<string, ActivityEventV1>>;

/** A prefix of the loaded activity window. Replay starts unknown and never reads current node states. */
export function graphFrame(nodes: readonly ActivityNodeV1[], events: readonly ActivityEventV1[], live: boolean) {
  const participants = new Map<string, GraphNode>(
    nodes.map(node => [node.id, { ...node, status: live ? node.status : 'unknown', activity: null, usage: null }]),
  );
  const visible = new Set<string>(live ? nodes.filter(node => node.recorded !== false).map(node => node.id) : []);
  const edges = new Map<string, GraphEdge>();
  const active: PendingActivity = new Map();
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
  const routes = pendingRoutes(active, participants);
  for (const edge of edges.values()) {
    const running = routes.get(edge.id);
    edge.active = running !== undefined;
    if (running) edge.event = running;
  }
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

function pendingRoutes(active: PendingActivity, nodes: Map<string, GraphNode>): Map<string, ActivityEventV1> {
  const routes = new Map<string, ActivityEventV1>();
  for (const [id, items] of active) {
    const node = nodes.get(id);
    if (!node || node.status !== 'active') continue;
    for (const event of items.values()) {
      node.activity = event;
      routes.set(`${event.source}>${event.target}`, event);
    }
  }
  return routes;
}

function seedConnections(nodes: readonly ActivityNodeV1[], visible: Set<string>, edges: Map<string, GraphEdge>): void {
  for (const node of nodes) {
    if (!node.parentId || !visible.has(node.id)) continue;
    const id = `${node.parentId}>${node.id}`;
    if (!edges.has(id))
      edges.set(id, { id, source: node.parentId, target: node.id, event: null, count: 0, active: false });
  }
}

function applyUpdates(nodes: Map<string, ActivityNodeV1>, active: PendingActivity, event: ActivityEventV1): void {
  for (const update of event.updates) {
    const node = nodes.get(update.nodeId);
    if (!node || (update.onlyIfActive && node.status !== 'active')) continue;
    if (update.label) node.label = update.label;
    const items = active.get(node.id) ?? new Map<string, ActivityEventV1>();
    const itemId = event.correlation.itemId;
    const key = JSON.stringify([event.correlation.runId, itemId]);
    if (update.status === 'active') {
      // Move repeated progress to the end so the visible label follows the latest unfinished work.
      items.delete(key);
      items.set(key, event);
    } else if (itemId) items.delete(key);
    else items.clear();
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
  const nodes = compactNodes(frame.nodes, ids);
  const edges = new Map<string, GraphEdge>();
  for (const edge of frame.edges) {
    const source = ids.get(edge.source) ?? edge.source,
      target = ids.get(edge.target) ?? edge.target;
    const id = `${source}>${target}`;
    const previous = edges.get(id);
    const representative = previous?.active && !edge.active ? previous : edge;
    edges.set(id, {
      ...representative,
      id,
      source,
      target,
      count: edge.count + (edges.get(id)?.count ?? 0),
      active: edge.active || (edges.get(id)?.active ?? false),
    });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function compactNodes(participants: GraphNode[], ids: Map<string, string>): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const node of participants) {
    const id = ids.get(node.id) ?? node.id;
    const previous = nodes.get(id);
    const representative = previous?.status === 'active' && node.status !== 'active' ? previous : node;
    nodes.set(id, { ...representative, id, label: representative.groupLabel ?? representative.label });
  }
  return nodes;
}
