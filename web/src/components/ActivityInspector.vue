<script setup lang="ts">
// Inspects selected structural observations as text; raw provider payloads are intentionally absent.
import type { ActivityEventV1 } from '../../../src/server/api-types';
import { localTime } from './format';
defineProps<{ event: ActivityEventV1 | undefined; related: ActivityEventV1[] }>();
defineEmits<{ select: [id: string] }>();
</script>

<template>
  <aside class="min-w-0 rounded-xl border border-default bg-default p-4" aria-label="Event details">
    <h2 class="mb-3 font-semibold text-highlighted">Event details</h2>
    <template v-if="event">
      <p class="font-medium break-words">{{ event.label }}</p>
      <p class="my-2 text-xs text-muted">{{ localTime(event.at) }} · {{ event.status }} · {{ event.provenance }}</p>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt>Type</dt>
        <dd class="break-all">{{ event.type }}</dd>
        <dt>Source</dt>
        <dd class="break-all">{{ event.source }}</dd>
        <dt>Destination</dt>
        <dd class="break-all">{{ event.target }}</dd>
        <dt>Duration</dt>
        <dd>{{ event.durationMs === null ? 'Unavailable' : `${event.durationMs} ms (reported)` }}</dd>
        <template v-for="(value, key) in event.correlation" :key="key"
          ><dt>{{ key }}</dt>
          <dd class="font-mono break-all">{{ value ?? 'Unavailable' }}</dd></template
        >
      </dl>
      <div v-if="event.usage" class="mt-4 rounded border border-default p-3 text-xs">
        <p class="font-medium">Reported usage</p>
        <p>
          Input {{ event.usage.input ?? 'unknown' }} · output {{ event.usage.output ?? 'unknown' }} · cached
          {{ event.usage.cached ?? 'unknown' }}
        </p>
        <p class="mt-1 text-muted">Scope: {{ event.usage.scope }}. These are not per-tool token costs.</p>
      </div>
      <h3 class="mt-4 text-sm font-medium">Redacted preview</h3>
      <pre class="mt-2 max-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap break-words">{{
        event.preview ?? 'No text preview retained for this event.'
      }}</pre>
      <h3 class="mt-4 text-sm font-medium">Related events in this window</h3>
      <ul class="mt-2 flex max-h-60 flex-col gap-1 overflow-auto">
        <li v-for="item in related" :key="item.id">
          <button
            type="button"
            class="text-left text-xs text-primary hover:underline"
            @click="$emit('select', item.id)"
          >
            {{ item.label }} · {{ item.status }}
          </button>
        </li>
      </ul>
    </template>
    <p v-else class="text-sm text-muted">Select an event or a participant to inspect its activity.</p>
  </aside>
</template>
