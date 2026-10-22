<!-- Comparisons: one request run under several recipes from the same base commit, scored side by side. -->
<script setup lang="ts">
import StatusIcon from '../components/StatusIcon.vue';
import { useComparisons } from '../composables/useComparisons';
import { useNow } from '../composables/useNow';
import { ago, comparisonStatusLook } from '../presentation';

const { comparisons, loaded, error } = useComparisons();
const now = useNow();
</script>

<template>
  <UDashboardPanel id="comparisons">
    <template #header>
      <UDashboardNavbar title="Comparisons" icon="i-lucide-git-compare-arrows">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton to="/new?compare=1" icon="i-lucide-plus" label="New comparison" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-5xl space-y-4">
        <p class="text-sm text-muted">
          A comparison runs one request under several recipes, each as its own task from the same base commit, so time,
          tokens, estimated cost and your effort can be compared fairly. In full mode every recipe writes its own spec
          and every result is also checked against the other specs.
        </p>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UEmpty
          v-if="loaded && !comparisons.length"
          icon="i-lucide-git-compare-arrows"
          title="No comparisons yet"
          description="Start one from New comparison, or with grampus compare."
        />
        <div class="grid gap-3">
          <RouterLink
            v-for="item in comparisons"
            :key="item.comparisonId"
            :to="`/comparisons/${item.comparisonId}`"
            class="flex items-start gap-3 rounded-lg border border-default p-4 hover:bg-elevated/50 transition-colors"
          >
            <StatusIcon :look="comparisonStatusLook[item.status]" class="mt-0.5" />
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex items-baseline justify-between gap-2">
                <p class="font-medium truncate">{{ item.title }}</p>
                <time class="text-xs text-dimmed shrink-0" :datetime="item.updatedAt">{{
                  ago(item.updatedAt, now)
                }}</time>
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <UBadge size="sm" variant="subtle" color="neutral">{{ item.mode }} mode</UBadge>
                <UBadge
                  v-for="recipe in item.recipes"
                  :key="recipe"
                  size="sm"
                  variant="outline"
                  color="neutral"
                  icon="i-lucide-chef-hat"
                >
                  {{ recipe }}
                </UBadge>
              </div>
              <p class="text-sm" :class="item.status === 'needs-you' ? 'text-warning' : 'text-muted'">
                {{ comparisonStatusLook[item.status].label }}{{ item.winner ? `: kept ${item.winner}` : '' }} ·
                {{ item.entries }} of {{ item.recipes.length }} entries started
              </p>
            </div>
          </RouterLink>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
