<script setup lang="ts">
// Draws ELK-routed observations; layout runs in a local worker and updates only when topology changes.
import { computed, onMounted, onScopeDispose, ref, useId, useTemplateRef } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { GraphEdge, GraphNode } from '../observability/graph';
import { graphGeometry, routePath } from '../observability/layout';
import { useGraphLayout } from '../observability/useGraphLayout';
import GraphConnector from './GraphConnector.vue';
import GraphParticipant from './GraphParticipant.vue';

const props = defineProps<{ nodes: GraphNode[]; edges: GraphEdge[]; live: boolean; compact?: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const markerId = useId();
const zoom = ref(1);
const viewport = useTemplateRef<HTMLElement>('viewport');
const viewportWidth = ref<number>(graphGeometry.emptyWidth);
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
        <GraphConnector
          v-for="edge in links"
          :key="edge.id"
          :edge="edge"
          :path="edge.path"
          :marker-id="markerId"
          :live="live"
        />
        <GraphParticipant
          v-for="node in drawn"
          :key="node.id"
          :node="node"
          :x="node.x"
          :y="node.y"
          :live="live"
          @select="emit('select', $event)"
        />
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
</style>
