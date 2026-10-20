<script setup lang="ts">
// Keeps the active operation visible without borrowing labels from completed grouped sessions.
import { computed } from 'vue';
import type { GraphNode } from '../observability/graph';
import { graphGeometry } from '../observability/layout';

const props = defineProps<{ node: GraphNode; x: number; y: number; live: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const running = computed(() => props.live && props.node.status === 'active');
const activity = computed(() => props.node.activity?.label ?? 'Activity unavailable in this window');
const tooltip = computed(() => {
  const { node } = props;
  const event = node.activity;
  return [
    node.label,
    `${node.status} · ${node.detail}`,
    activity.value,
    `Request: ${event?.correlation.runId ?? 'unavailable'}`,
    `Reported duration: ${event?.durationMs === null || !event ? 'unavailable' : `${event.durationMs} ms`}`,
    `Input: ${node.usage?.input ?? 'unknown'} · output: ${node.usage?.output ?? 'unknown'} · cached: ${node.usage?.cached ?? 'unknown'}`,
    'Token counts are session snapshots, not per-call costs.',
  ].join('\n');
});
const truncate = (text: string) => (text.length > 28 ? `${text.slice(0, 27)}…` : text);
</script>

<template>
  <g
    :transform="`translate(${x},${y})`"
    class="network-node"
    :class="[node.kind, node.status, { live: running }]"
    tabindex="0"
    role="button"
    :aria-label="`${node.label}: ${node.status}. ${activity}. ${node.detail}`"
    @click="emit('select', node.id)"
    @keydown.enter="emit('select', node.id)"
    @keydown.space.prevent="emit('select', node.id)"
  >
    <title>{{ tooltip }}</title>
    <rect
      v-if="running"
      class="activity-halo"
      x="-3"
      y="-3"
      :width="graphGeometry.nodeWidth + 6"
      :height="graphGeometry.nodeHeight + 6"
      rx="15"
      aria-hidden="true"
    />
    <rect class="node-box" :width="graphGeometry.nodeWidth" :height="graphGeometry.nodeHeight" rx="12" />
    <circle cx="15" cy="21" r="4" />
    <text x="27" y="25" class="node-label">
      {{ node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label }}
    </text>
    <text x="14" y="47" class="node-state">{{ running ? 'Live' : node.status }} · {{ node.kind }}</text>
    <text x="14" y="67" class="node-activity">{{ truncate(activity) }}</text>
  </g>
</template>

<style scoped>
.network-node {
  cursor: pointer;
  outline: none;
}
.node-box {
  fill: var(--ui-bg);
  stroke: var(--ui-border);
  stroke-width: 1.5;
}
circle {
  fill: var(--ui-text-muted);
}
text {
  fill: var(--ui-text-highlighted);
  font-family: inherit;
}
.node-label {
  font-size: 12px;
  font-weight: 600;
}
.node-state,
.node-activity {
  font-size: 10px;
  fill: var(--ui-text-muted);
}
.active .node-box,
.network-node:focus .node-box,
.network-node:hover .node-box {
  stroke: var(--ui-primary);
}
.active circle,
.live .node-activity {
  fill: var(--ui-primary);
}
.live .node-activity {
  font-weight: 600;
}
.activity-halo {
  fill: none;
  stroke: var(--ui-primary);
  stroke-width: 2;
  animation: activity-pulse 1.8s ease-in-out infinite;
  pointer-events: none;
}
.completed {
  opacity: 0.55;
}
.failed .node-box,
.interrupted .node-box {
  stroke: var(--ui-error);
}
.model .node-box {
  fill: color-mix(in srgb, var(--ui-primary) 5%, var(--ui-bg));
}
@keyframes activity-pulse {
  0%,
  100% {
    opacity: 0.15;
  }
  50% {
    opacity: 0.8;
  }
}
@media (prefers-reduced-motion: reduce) {
  .activity-halo {
    animation: none;
    opacity: 0.65;
  }
}
</style>
