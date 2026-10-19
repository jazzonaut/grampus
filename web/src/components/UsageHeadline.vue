<script setup lang="ts">
/** Owns the compact measured usage display shared by planning and execution headers. */
import type { UsageHeadlineV1 } from '../../../src/server/api-types';
import { formatTokens, formatUsd, plural } from './format';
defineProps<{ usage: UsageHeadlineV1 }>();
const labels = {
  none: 'No measurements yet',
  partial: 'Partial, a lower bound',
  live: 'Live, may increase',
  complete: 'Measured',
};
</script>

<template>
  <div data-usage-headline>
    <p class="text-xs text-muted">Token usage</p>
    <p class="mt-1 font-semibold text-highlighted">
      {{ usage.tokens === null ? 'Usage unknown' : `${formatTokens(usage.tokens)} tokens` }}
    </p>
    <p class="mt-1 text-xs text-muted">
      {{ labels[usage.completeness] }} · {{ plural(usage.turns, 'turn')
      }}<template v-if="usage.estimatedCostUsd !== null"> · {{ formatUsd(usage.estimatedCostUsd) }} estimated</template>
    </p>
  </div>
</template>
