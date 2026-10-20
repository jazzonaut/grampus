<script setup lang="ts">
// Shows the filtered event window. Selecting a row does not execute or replay any operation.
import type { ActivityEventV1 } from '../../../src/server/api-types';
import type { GraphNode } from '../observability/graph';
import { computed } from 'vue';
import { localTime } from './format';
const props = defineProps<{ events: ActivityEventV1[]; selected: string | null; nodes: GraphNode[] }>();
const labels = computed(() => new Map(props.nodes.map(node => [node.id, node.label])));
defineEmits<{ select: [id: string] }>();
</script>

<template>
  <div class="max-h-96 overflow-auto rounded-xl border border-default">
    <table class="w-full text-left text-xs">
      <caption class="sticky top-0 bg-default p-3 text-left font-semibold">
        Event timeline ·
        {{
          events.length
        }}
        matching events
      </caption>
      <thead class="bg-muted">
        <tr>
          <th class="p-2">Time</th>
          <th class="p-2">Activity</th>
          <th class="p-2">Status</th>
          <th class="p-2">Source → destination</th>
          <th class="p-2">Provenance</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="event in events"
          :key="event.id"
          class="border-t border-default"
          :class="{ 'bg-primary/10': selected === event.id }"
        >
          <td class="p-2 whitespace-nowrap">{{ localTime(event.at) }}</td>
          <td class="p-2">
            <button type="button" class="text-left text-primary hover:underline" @click="$emit('select', event.id)">
              {{ event.label }}
            </button>
          </td>
          <td class="p-2">{{ event.status }}</td>
          <td class="p-2">
            {{ labels.get(event.source) ?? event.source }} → {{ labels.get(event.target) ?? event.target }}
          </td>
          <td class="p-2">{{ event.provenance }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
