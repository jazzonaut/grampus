<script setup lang="ts">
// Draws ELK-routed observations; layout runs in a local worker and updates only when topology changes.
import { computed, onMounted, onScopeDispose, ref, useId, useTemplateRef } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { GraphEdge, GraphNode } from '../observability/graph';
import { graphGeometry, routePath } from '../observability/layout';
import { useGraphLayout } from '../observability/useGraphLayout';

const props = defineProps<{ nodes: GraphNode[]; edges: GraphEdge[]; live: boolean; compact?: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const markerId = useId();
const zoom = ref(1);
const viewport = useTemplateRef<HTMLElement>('viewport');
const viewportWidth = ref<number>(graphGeometry.emptyWidth);
const boxWidth = graphGeometry.nodeWidth;
const boxHeight = graphGeometry.nodeHeight;
const layout = useGraphLayout(
  () => props.nodes,
  () => props.edges,
);
const geometry = layout.geometry;
const displayScale = computed(() => Math.min(1, viewportWidth.value / geometry.value.width) * zoom.value);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!viewport.value) return;
  viewportWidth.value = viewport.value.clientWidth;
  observer = new ResizeObserver(entries => {
    const entry = entries[0];
    if (entry) viewportWidth.value = entry.contentRect.width;
  });
  observer.observe(viewport.value);
});
onScopeDispose(() => observer?.disconnect());
const drawn = computed(() =>
  props.nodes.flatMap(node => {
    const position = geometry.value.nodes.get(node.id);
    return position ? [{ ...node, ...position }] : [];
  }),
);
const links = computed(() =>
  props.edges.flatMap(edge => {
    const sections = geometry.value.edges.get(edge.id);
    return sections ? [{ ...edge, path: routePath(sections) }] : [];
  }),
);
function tooltip(node: GraphNode): string {
  const activity = node.activity;
  return [
    node.label,
    `${node.status} · ${node.detail}`,
    activity?.label ?? 'Activity unavailable in this window',
    `Request: ${activity?.correlation.runId ?? 'unavailable'}`,
    `Reported duration: ${activity?.durationMs === null || !activity ? 'unavailable' : `${activity.durationMs} ms`}`,
    `Input: ${node.usage?.input ?? 'unknown'} · output: ${node.usage?.output ?? 'unknown'} · cached: ${node.usage?.cached ?? 'unknown'}`,
    'Token counts are session snapshots, not per-call costs.',
  ].join('\n');
}
</script>

<template>
  <div class="execution-network">
    <div v-if="!compact" class="mb-2 flex items-center justify-end gap-2">
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-minus"
        aria-label="Zoom out"
        @click="zoom = Math.max(0.5, zoom - 0.25)"
      />
      <UButton color="neutral" variant="outline" size="sm" label="Reset zoom" @click="zoom = 1" />
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-plus"
        aria-label="Zoom in"
        @click="zoom = Math.min(2, zoom + 0.25)"
      />
    </div>
    <p v-if="layout.error.value" role="alert" class="mb-2 text-sm text-error">
      Graph layout unavailable: {{ layout.error.value }}. Any retained geometry may be stale.
    </p>
    <p v-else-if="layout.arranging.value" role="status" class="text-xs text-muted">Arranging network…</p>
    <div
      ref="viewport"
      class="network-scroll"
      :class="{ compact }"
      tabindex="0"
      aria-label="Execution network; scroll to pan"
    >
      <svg
        :viewBox="`0 0 ${geometry.width} ${geometry.height}`"
        :width="geometry.width * displayScale"
        :height="geometry.height * displayScale"
        role="group"
        aria-label="Observed execution network"
      >
        <defs>
          <marker
            :id="markerId"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <path
          v-for="edge in links"
          :key="edge.id"
          :d="edge.path"
          class="network-link"
          :class="{ flowing: live && edge.active, settled: !edge.active }"
          :marker-end="`url(#${markerId})`"
        >
          <title>
            {{
              edge.event
                ? `${edge.event.label} · ${edge.count} events · ${edge.event.provenance}`
                : 'Previously observed relationship; select a participant to inspect retained events.'
            }}
          </title>
        </path>
        <g
          v-for="node in drawn"
          :key="node.id"
          :transform="`translate(${node.x},${node.y})`"
          class="network-node"
          :class="[node.kind, node.status]"
          tabindex="0"
          role="button"
          :aria-label="`${node.label}: ${node.status}. ${node.detail}`"
          @click="emit('select', node.id)"
          @keydown.enter="emit('select', node.id)"
          @keydown.space.prevent="emit('select', node.id)"
        >
          <title>{{ tooltip(node) }}</title>
          <rect :width="boxWidth" :height="boxHeight" rx="12" />
          <circle cx="15" cy="21" r="4" />
          <text x="27" y="25" class="node-label">
            {{ node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label }}
          </text>
          <text x="14" y="48" class="node-state">{{ node.status }} · {{ node.kind }}</text>
        </g>
      </svg>
    </div>
    <p v-if="!nodes.some(node => node.kind === 'agent')" class="text-sm text-muted">
      No provider communication recorded yet.
    </p>
  </div>
</template>

<style scoped>
.network-scroll {
  overflow: auto;
  border-radius: 12px;
  background-image: radial-gradient(var(--ui-border) 1px, transparent 1px);
  background-size: 18px 18px;
}
svg {
  display: block;
}
.compact {
  max-height: 380px;
}
.network-link {
  fill: none;
  stroke: var(--ui-primary);
  stroke-width: 1.6;
  opacity: 0.55;
  color: var(--ui-primary);
}
.flowing {
  stroke-dasharray: 7 5;
  animation: flow 0.8s linear infinite;
  opacity: 1;
}
.settled {
  stroke: var(--ui-text-dimmed);
  color: var(--ui-text-dimmed);
  opacity: 0.45;
}
.network-node {
  cursor: pointer;
  outline: none;
}
.network-node rect {
  fill: var(--ui-bg);
  stroke: var(--ui-border);
  stroke-width: 1.5;
}
.network-node circle {
  fill: var(--ui-text-muted);
}
.network-node text {
  fill: var(--ui-text-highlighted);
  font-family: inherit;
}
.node-label {
  font-size: 12px;
  font-weight: 600;
}
.network-node .node-state {
  font-size: 11px;
  fill: var(--ui-text-muted);
}
.active rect,
.network-node:focus rect,
.network-node:hover rect {
  stroke: var(--ui-primary);
}
.active circle {
  fill: var(--ui-primary);
}
.completed {
  opacity: 0.55;
}
.failed rect,
.interrupted rect {
  stroke: var(--ui-error);
}
.model rect {
  fill: color-mix(in srgb, var(--ui-primary) 5%, var(--ui-bg));
}
@keyframes flow {
  to {
    stroke-dashoffset: -24;
  }
}
@media (prefers-reduced-motion: reduce) {
  .flowing {
    animation: none;
  }
}
</style>
