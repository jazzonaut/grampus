<script setup lang="ts">
// Renders directional traffic only while a recorded operation on this route remains unfinished.
import type { GraphEdge } from '../observability/graph';

defineProps<{ edge: GraphEdge; path: string; markerId: string; live: boolean }>();
</script>

<template>
  <g class="network-connection" :class="{ live: live && edge.active, settled: !edge.active }">
    <title>
      {{
        edge.event
          ? `${edge.event.label} · ${edge.count} events · ${edge.event.provenance}`
          : 'Previously observed relationship; select a participant to inspect retained events.'
      }}
    </title>
    <path :d="path" class="network-link" :marker-end="`url(#${markerId})`" />
    <path v-if="live && edge.active" :d="path" class="network-traffic" aria-hidden="true" />
  </g>
</template>

<style scoped>
.network-connection {
  color: var(--ui-primary);
}
.network-link,
.network-traffic {
  fill: none;
  stroke: currentColor;
}
.network-link {
  stroke-width: 1.6;
  opacity: 0.55;
}
.live .network-link {
  stroke-width: 2.5;
  opacity: 0.65;
}
.network-traffic {
  stroke-width: 6;
  stroke-linecap: round;
  stroke-dasharray: 0.1 23.9;
  animation: traffic 1.2s linear infinite;
  pointer-events: none;
}
.settled {
  color: var(--ui-text-dimmed);
  opacity: 0.65;
}
@keyframes traffic {
  to {
    stroke-dashoffset: -48;
  }
}
@media (prefers-reduced-motion: reduce) {
  .network-traffic {
    animation: none;
  }
}
</style>
