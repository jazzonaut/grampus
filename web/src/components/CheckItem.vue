<script setup lang="ts">
/**
 * CheckItem: one preparation, validation or acceptance run (`CheckView`): its state in words, who
 * established it, the compact failure summary, the exact command and its output on request.
 *
 * Props:
 * - `check`: the server's `CheckView`.
 */
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { CheckView } from '../../../src/server/api-types';
import { evidenceLabels, stagePresentation } from '../theme/status';
import CheckOutput from './CheckOutput.vue';
import CommandDetails from './CommandDetails.vue';
import { formatTimeout } from './format';

defineOptions({ name: 'CheckItem' });

defineProps<{ check: CheckView }>();
</script>

<template>
  <details class="rounded-md border border-default" :open="check.state === 'failed'" :data-check="check.id">
    <summary class="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 select-none hover:bg-muted">
      <UIcon :name="stagePresentation[check.state].icon" class="size-4 shrink-0" aria-hidden="true" />
      <span class="font-medium text-highlighted">{{ check.name }}</span>
      <span class="text-xs text-muted">{{ check.purposeLabel }} · {{ check.stateLabel }}</span>
      <span v-if="check.evidence" class="text-xs text-muted">· {{ evidenceLabels[check.evidence] }}</span>
    </summary>
    <div class="flex flex-col gap-2 border-t border-default px-3 py-2 text-sm">
      <pre v-if="check.issue" class="grampus-code border-l-2 border-error" data-issue>{{ check.issue }}</pre>
      <p v-if="check.error" class="text-error">{{ check.error }}</p>
      <p class="text-xs text-muted">
        Timeout {{ formatTimeout(check.timeoutMs)
        }}<template v-if="check.exitCode !== null"> · exit code {{ check.exitCode }}</template
        ><template v-if="check.reason"> · {{ check.reason }}</template
        ><template v-if="check.outputTruncated"> · output truncated in the journal preview</template
        ><template v-if="check.outputUnavailable"> · output unavailable</template>
      </p>
      <CommandDetails :command="check.command" />
      <CheckOutput
        :output-path="check.outputPath"
        :name="check.name"
        :characters="{ stdout: check.stdoutCharacters, stderr: check.stderrCharacters }"
      />
    </div>
  </details>
</template>
