<!-- A concise explanation sits beside the code when the workspace has enough room. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { CodeReference } from '../../../src/domain/explanation';
import type { ChangesView, DiffView, TaskDetail } from '../../../src/dashboard/types';
import { getJson, sendJson } from '../api/client';
import { shortSha } from '../presentation';
import DiffFile from './DiffFile.vue';
import ChangedFileTree from './ChangedFileTree.vue';
import MarkdownView from './MarkdownView.vue';
import ChangeNote from './ChangeNote.vue';

const props = defineProps<{ task: TaskDetail }>();
const changes = ref<ChangesView | null>(null);
const delta = ref<ChangesView | null>(null);
const deltaError = ref<string | null>(null);
const error = ref<string | null>(null);
const fullChange = ref(false);
const selectedFile = ref<string | null>(null);
const selectedCode = ref<CodeReference | null>(null);
const selectedCodeVersion = ref<{ candidateSha: string; specVersion: number | null } | null>(null);
const highlighted = ref<CodeReference | null>(null);
const groupId = ref<string | null>(null);
const explanationOpen = ref(true);
const question = ref('');
const busy = ref(false);
const drafts = ref<
  {
    text: string;
    reference: CodeReference | null;
    discussion: string | null;
    candidateSha: string;
    specVersion: number | null;
  }[]
>([]);
const draftText = ref('');
const discussionContext = ref<string | null>(null);
const prText = ref('');
const prPreview = ref(false);
const fileDiff = ref<DiffView | null>(null);
const diffError = ref<string | null>(null);

const current = computed(() => {
  const bound = (entry: TaskDetail['explanations'][number]) =>
    entry.candidateSha === changes.value?.sha &&
    entry.baseSha === props.task.worktree?.baseSha &&
    entry.specVersion === changes.value?.specVersion;
  return (
    props.task.explanations.findLast(entry => bound(entry) && !!entry.explanation) ??
    props.task.explanations.findLast(bound)
  );
});
const prior = computed(() =>
  [...props.task.explanations].reverse().find(entry => entry.candidateSha !== changes.value?.sha && entry.explanation),
);
const explanation = computed(() => current.value?.explanation ?? prior.value?.explanation ?? null);
// Unlabelled prose stays intact rather than guessing which claims describe the old behaviour.
const comparison = computed(() => {
  const match = /^\s*Before:\s*([\s\S]+?)\s+After:\s*([\s\S]+)$/i.exec(explanation.value?.beforeAfter ?? '');
  return match?.[1] && match[2] ? { before: match[1], after: match[2] } : null;
});
const groups = computed(() => explanation.value?.groups ?? []);
const activeGroup = computed(() => groups.value.find(group => group.id === groupId.value) ?? null);
const currentAnswers = computed(() =>
  props.task.answers.filter(
    answer => answer.candidateSha === changes.value?.sha && answer.specVersion === changes.value?.specVersion,
  ),
);
const generation = computed(
  () =>
    props.task.stages.some(
      stage => stage.stage === 'explain' && stage.dispatches.some(dispatch => !dispatch.settled && !dispatch.exited),
    ) || props.task.commands.some(command => command.kind === 'explain' && command.state === 'queued'),
);
const reviewReady = computed(
  () =>
    (!!props.task.finished &&
      props.task.rounds.some(
        round => round.checks?.sha === changes.value?.sha || round.polish?.decided?.sha === changes.value?.sha,
      )) ||
    ['ready:', 'escalate:'].some(prefix => props.task.needsYou?.reason.startsWith(prefix)),
);
const fromSha = computed(() =>
  !fullChange.value && prior.value && delta.value ? prior.value.candidateSha : (changes.value?.baseSha ?? null),
);
const visibleChanges = computed(() => (!fullChange.value && prior.value && delta.value ? delta.value : changes.value));
const visibleFiles = computed(() => visibleChanges.value?.files ?? []);
const storageKey = computed(
  () =>
    `grampus-review:${props.task.taskId}:${changes.value?.baseSha ?? ''}:${changes.value?.sha ?? ''}:v${changes.value?.specVersion ?? ''}`,
);
const markerKey = computed(
  () => `${storageKey.value}:${current.value?.commandId ?? prior.value?.commandId ?? 'none'}:markers`,
);
const markers = ref<string[]>([]);
function storedMarkers(entry: TaskDetail['explanations'][number]): string[] {
  try {
    return JSON.parse(
      localStorage.getItem(
        `grampus-review:${props.task.taskId}:${entry.baseSha}:${entry.candidateSha}:v${entry.specVersion}:${entry.commandId}:markers`,
      ) ?? '[]',
    ) as string[];
  } catch {
    return [];
  }
}
const priorMarkers = computed(() => {
  if (!prior.value) return [];
  return storedMarkers(prior.value);
});
const earlierCurrent = computed(() =>
  [...props.task.explanations]
    .reverse()
    .find(
      entry =>
        entry.candidateSha === current.value?.candidateSha &&
        entry.specVersion === current.value?.specVersion &&
        entry.commandId !== current.value?.commandId &&
        entry.explanation,
    ),
);
const needsAnotherLook = computed(() => {
  const changed = new Set(delta.value?.files.map(file => file.path) ?? []);
  return new Set(
    groups.value
      .filter(
        group =>
          (priorMarkers.value.includes(group.id) && group.references.some(reference => changed.has(reference.path))) ||
          (earlierCurrent.value &&
            storedMarkers(earlierCurrent.value).includes(group.id) &&
            JSON.stringify(group) !==
              JSON.stringify(earlierCurrent.value.explanation?.groups.find(previous => previous.id === group.id))),
      )
      .map(group => group.id),
  );
});
const lastContinue = computed(() =>
  [...props.task.commands].reverse().find(command => command.kind === 'continue' && command.state === 'applied'),
);
const feedbackItems = computed(() => lastContinue.value?.text?.split(/\r?\n/).filter(Boolean) ?? []);
function changedFeedbackPath(item: string): string | null {
  const path = /\((.+?):\d+-\d+ at /.exec(item)?.[1];
  return path && delta.value?.files.some(file => file.path === path) ? path : null;
}

watch(
  () => [props.task.taskId, props.task.updatedAt],
  async (_value, _previous, onCleanup) => {
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    try {
      const next = await getJson<ChangesView>(`/api/tasks/${encodeURIComponent(props.task.taskId)}/changes`);
      if (stale) return;
      const moved = changes.value?.sha !== next.sha;
      changes.value = next;
      if (moved) {
        selectedFile.value = next.files[0]?.path ?? null;
        fileDiff.value = null;
        selectedCode.value = null;
        selectedCodeVersion.value = null;
        highlighted.value = null;
        groupId.value = null;
        explanationOpen.value = true;
        fullChange.value = false;
      }
      error.value = null;
    } catch (failure) {
      if (stale) return;
      error.value = (failure as Error).message;
    }
  },
  { immediate: true },
);
watch(
  () => [props.task.taskId, prior.value?.candidateSha, changes.value?.sha],
  async (_value, _previous, onCleanup) => {
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    delta.value = null;
    if (!prior.value || !changes.value) {
      delta.value = null;
      deltaError.value = null;
      return;
    }
    try {
      const result = await getJson<ChangesView>(
        `/api/tasks/${encodeURIComponent(props.task.taskId)}/changes?from=${encodeURIComponent(prior.value.candidateSha)}`,
      );
      if (stale) return;
      if (result.sha !== changes.value.sha) throw new Error('The candidate changed.');
      delta.value = result;
      deltaError.value = null;
    } catch {
      if (stale) return;
      delta.value = null;
      deltaError.value = 'The earlier commit is unavailable for a repair comparison. The full task diff is shown.';
    }
  },
  { immediate: true },
);
watch(
  storageKey,
  key => {
    if (!changes.value) return;
    try {
      drafts.value = JSON.parse(localStorage.getItem(`${key}:drafts`) ?? '[]') as typeof drafts.value;
    } catch {
      drafts.value = [];
    }
    prText.value = localStorage.getItem(`${key}:pr`) ?? '';
  },
  { immediate: true },
);
watch(
  markerKey,
  key => {
    try {
      markers.value = JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
    } catch {
      markers.value = [];
    }
  },
  { immediate: true },
);
watch(drafts, value => localStorage.setItem(`${storageKey.value}:drafts`, JSON.stringify(value)), { deep: true });
watch(markers, value => localStorage.setItem(markerKey.value, JSON.stringify(value)), { deep: true });
watch(prText, value => {
  if (changes.value) localStorage.setItem(`${storageKey.value}:pr`, value);
});
watch(
  () => [props.task.taskId, selectedFile.value, fromSha.value, changes.value?.sha],
  async (_value, _previous, onCleanup) => {
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    fileDiff.value = null;
    diffError.value = null;
    if (!selectedFile.value || !fromSha.value || !changes.value) return;
    const path = selectedFile.value;
    const from = fromSha.value;
    const sha = changes.value.sha;
    try {
      const result = await getJson<DiffView>(
        `/api/tasks/${encodeURIComponent(props.task.taskId)}/diff?path=${encodeURIComponent(path)}&from=${from}`,
      );
      if (stale) return;
      if (result.sha !== sha || result.baseSha !== from)
        throw new Error('The candidate changed while loading this diff. Refresh Changes before selecting code.');
      fileDiff.value = result;
      await nextTick();
      if (highlighted.value?.path === path)
        document
          .getElementById(`code-${path}-${highlighted.value.start}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (failure) {
      if (!stale) diffError.value = (failure as Error).message;
    }
  },
  { immediate: true },
);
watch(visibleFiles, files => {
  if (!files.some(file => file.path === selectedFile.value)) selectedFile.value = files[0]?.path ?? null;
});

async function explain(): Promise<void> {
  if (!changes.value?.specVersion) return;
  busy.value = true;
  try {
    await sendJson('POST', `/api/tasks/${encodeURIComponent(props.task.taskId)}/commands`, {
      kind: 'explain',
      baseSha: props.task.worktree?.baseSha,
      candidateSha: changes.value.sha,
      specVersion: changes.value.specVersion,
    });
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = false;
  }
}
async function ask(): Promise<void> {
  if (!changes.value?.specVersion || !question.value.trim()) return;
  busy.value = true;
  try {
    await sendJson('POST', `/api/tasks/${encodeURIComponent(props.task.taskId)}/commands`, {
      kind: 'ask',
      baseSha: props.task.worktree?.baseSha,
      candidateSha: changes.value.sha,
      specVersion: changes.value.specVersion,
      question: question.value.trim(),
      groupId: groupId.value,
      reference: selectedCode.value,
    });
    question.value = '';
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = false;
  }
}
function chooseCode(reference: CodeReference): void {
  selectedCode.value = reference;
  selectedCodeVersion.value = {
    candidateSha: changes.value?.sha ?? '',
    specVersion: changes.value?.specVersion ?? null,
  };
  const match = groups.value.find(group =>
    group.references.some(
      item => item.path === reference.path && item.start <= reference.end && item.end >= reference.start,
    ),
  );
  if (match) groupId.value = match.id;
}
async function jump(reference: CodeReference, candidateSha?: string): Promise<void> {
  if (candidateSha && candidateSha !== changes.value?.sha) {
    error.value = `This reference belongs to the earlier candidate ${shortSha(candidateSha)}. Its line numbers cannot be used in the current diff.`;
    return;
  }
  error.value = null;
  highlighted.value = reference;
  // A repair-only comparison may omit the referenced file entirely.
  fullChange.value = true;
  selectedFile.value = reference.path;
  await nextTick();
  document
    .getElementById(`code-${reference.path}-${reference.start}`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function addDraft(): void {
  if (!draftText.value.trim()) return;
  const binding = selectedCode.value ? selectedCodeVersion.value : null;
  drafts.value.push({
    text: draftText.value.trim(),
    reference: selectedCode.value,
    discussion: discussionContext.value,
    candidateSha: binding?.candidateSha ?? changes.value?.sha ?? '',
    specVersion: binding?.specVersion ?? changes.value?.specVersion ?? null,
  });
  draftText.value = '';
  discussionContext.value = null;
}
function requestFromDiscussion(answer: TaskDetail['answers'][number]): void {
  discussionContext.value = answer.question;
  selectedCode.value = answer.answer?.references[0] ?? answer.reference;
  selectedCodeVersion.value = { candidateSha: answer.candidateSha, specVersion: answer.specVersion };
}
async function submitFeedback(): Promise<void> {
  if (busy.value || !drafts.value.length || !props.task.needsYou?.options.includes('continue')) return;
  if (drafts.value.some(item => !item.text.trim())) {
    error.value = 'Every change request needs text. Fill in or remove empty requests before continuing.';
    return;
  }
  const sent = new Map(drafts.value.map(item => [item, item.text]));
  const guidance = drafts.value
    .map(
      (item, index) =>
        `${index + 1}. ${item.text.trim()}${item.reference ? ` (${item.reference.path}:${item.reference.start}-${item.reference.end} at ${shortSha(item.candidateSha)}, spec v${item.specVersion ?? '?'})` : ''}${item.discussion ? ` [Discussion: ${item.discussion}]` : ''}`,
    )
    .join('\n');
  busy.value = true;
  try {
    await sendJson('POST', `/api/tasks/${encodeURIComponent(props.task.taskId)}/commands`, {
      kind: 'continue',
      guidance,
    });
    // Adding or editing guidance while the request travels must not silently lose that later work.
    drafts.value = drafts.value.filter(item => sent.get(item) !== item.text);
    error.value = null;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = false;
  }
}
function mark(group: string): void {
  markers.value = markers.value.includes(group)
    ? markers.value.filter(item => item !== group)
    : [...markers.value, group];
}
function preparePr(): void {
  if (!explanation.value || !changes.value) return;
  const entry = explanation.value;
  const checks = props.task.rounds.at(-1)?.checks;
  const links = changes.value.repositoryUrl
    ? `\n\n## Key code\n\n${entry.groups.flatMap(group => group.references.slice(0, 2).map(reference => `- [${group.title}: ${reference.path}:${reference.start}](${changes.value?.repositoryUrl}/blob/${changes.value?.sha}/${reference.path.split('/').map(encodeURIComponent).join('/')}#L${reference.start})`)).join('\n')}`
    : '';
  prText.value = `## Problem\n\n${entry.problem}\n\n## Approach\n\n${entry.approach}\n\n## Decisions\n\n${entry.decisions}\n\n## Validation\n\n${entry.validation}${checks ? `\n\nRecorded checks at ${shortSha(checks.sha)}: ${checks.results.filter(result => result.passed).length}/${checks.results.length} passed.` : ''}\n\n## Limitations\n\n${entry.limitations}${links}${
    currentAnswers.value.length
      ? `\n\n## Review clarifications\n\n${currentAnswers.value
          .filter(answer => answer.answer)
          .map(answer => `- **${answer.question}** ${answer.answer?.answer ?? ''}`)
          .join('\n')}`
      : ''
  }\n`;
}
async function copyPr(): Promise<void> {
  await navigator.clipboard.writeText(prText.value);
}
</script>

<template>
  <div class="changes-tab space-y-4 min-w-0">
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div v-if="changes" class="flex flex-wrap items-center gap-2">
      <span class="text-sm text-muted"
        >{{ shortSha(changes.baseSha) }} → {{ shortSha(changes.sha) }} · spec v{{ changes.specVersion ?? '?' }}</span
      >
      <UBadge v-if="prior && !current" color="warning" variant="subtle">Explanation needs updating</UBadge>
      <UButton
        v-if="changes.specVersion && (!current?.explanation || current?.error)"
        size="sm"
        icon="i-lucide-book-open"
        :loading="busy || generation"
        :disabled="generation || !reviewReady"
        @click="explain"
        >{{ generation ? 'Explaining…' : 'Explain changes' }}</UButton
      >
      <UButton
        v-if="explanation"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-book-open"
        :aria-expanded="explanationOpen"
        aria-controls="change-explanation"
        @click="explanationOpen = !explanationOpen"
        >{{ explanationOpen ? 'Close explanation' : 'Open explanation' }}</UButton
      >
      <span v-if="current?.error" class="text-xs text-warning">{{ current.error }}</span>
    </div>
    <div v-else class="space-y-2"><USkeleton class="h-5 w-1/2" /><USkeleton class="h-64" /></div>
    <div class="changes-workspace" :class="{ 'with-explanation': explanationOpen && explanation }">
      <UCard v-if="explanationOpen && explanation" id="change-explanation" class="min-w-0">
        <template #header
          ><h3 class="font-semibold flex items-center gap-2">
            <UIcon name="i-lucide-file-diff" class="size-4 text-muted" />What the agent changed
          </h3></template
        >
        <div class="space-y-5 text-sm min-w-0">
          <UAlert
            v-if="!current?.explanation"
            color="warning"
            variant="subtle"
            title="Earlier candidate"
            description="This explanation refers to a previous commit. Its references may have moved."
          />
          <div class="rounded-lg bg-elevated p-3 border-l-2 border-primary/50">
            <ChangeNote :source="explanation.approach" />
          </div>
          <section aria-label="Before and after">
            <div v-if="comparison" class="grid grid-cols-1 gap-3 @min-[24rem]:grid-cols-2">
              <div class="rounded-lg border border-default p-3 min-w-0">
                <h4 class="text-xs font-semibold text-muted mb-2">Before</h4>
                <ChangeNote :source="comparison.before" />
              </div>
              <div class="rounded-lg border border-default bg-elevated/50 p-3 min-w-0">
                <h4 class="text-xs font-semibold mb-2">After</h4>
                <ChangeNote :source="comparison.after" />
              </div>
            </div>
            <template v-else
              ><h4 class="font-semibold mb-2">Before and after</h4>
              <ChangeNote :source="explanation.beforeAfter"
            /></template>
          </section>
          <section>
            <h4 class="font-semibold mb-2">Key changes</h4>
            <ul class="divide-y divide-default">
              <li v-for="group in groups" :key="group.id" class="py-3 first:pt-0 min-w-0">
                <button
                  type="button"
                  class="text-left font-medium hover:text-primary focus-visible:outline-primary"
                  @click="
                    groupId = group.id;
                    if (group.references[0])
                      jump(group.references[0], current?.explanation ? changes?.sha : prior?.candidateSha);
                  "
                >
                  {{ group.title }}<span v-if="markers.includes(group.id)" class="ml-1">✓</span>
                </button>
                <span v-if="needsAnotherLook.has(group.id)" class="block text-xs text-warning">Needs another look</span>
                <ChangeNote class="mt-1 text-muted" :source="group.purpose" />
                <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  <button
                    v-for="reference in group.references"
                    :key="`${reference.path}:${reference.start}`"
                    type="button"
                    class="text-xs font-mono text-primary text-left break-all underline underline-offset-2 focus-visible:outline-primary"
                    @click="jump(reference, current?.explanation ? changes?.sha : prior?.candidateSha)"
                  >
                    {{ reference.path }}:{{ reference.start }}
                  </button>
                </div>
              </li>
            </ul>
          </section>
          <section v-if="explanation.limitations" class="border-l-2 border-default pl-3">
            <h4 class="text-xs font-semibold text-muted mb-1">Caveats</h4>
            <ChangeNote :source="explanation.limitations" />
          </section>
          <details class="border-y border-default">
            <summary class="cursor-pointer py-3 font-medium focus-visible:outline-primary">
              More detail <span class="text-xs text-muted font-normal">· rationale and evidence</span>
            </summary>
            <section
              v-for="item in [
                ['Problem', explanation.problem],
                ['Architecture', explanation.architecture],
                ['Decisions', explanation.decisions],
                ['Validation', explanation.validation],
              ].filter(item => item[1])"
              :key="item[0]"
              class="pb-4"
            >
              <h4 class="font-medium mb-1">{{ item[0] }}</h4>
              <MarkdownView :source="item[1] ?? ''" />
            </section>
          </details>
          <section v-if="activeGroup" class="rounded-lg border border-primary/30 p-3">
            <div class="flex justify-between gap-2">
              <h4 class="font-semibold">{{ activeGroup.title }}</h4>
              <UButton size="xs" color="neutral" variant="outline" @click="mark(activeGroup.id)">{{
                markers.includes(activeGroup.id) ? 'Reviewed ✓' : 'Mark reviewed'
              }}</UButton>
            </div>
            <div class="flex flex-wrap gap-1 mt-2">
              <UButton
                v-for="reference in activeGroup.references"
                :key="`${reference.path}:${reference.start}`"
                size="xs"
                color="neutral"
                variant="link"
                class="px-0"
                @click="jump(reference, current?.explanation ? changes?.sha : prior?.candidateSha)"
                >{{ reference.path }}:{{ reference.start }}</UButton
              >
            </div>
          </section>
          <p v-if="selectedCode" class="text-xs text-primary">
            Selected code: {{ selectedCode.path }}:{{ selectedCode.start
            }}<template v-if="selectedCode.end !== selectedCode.start">-{{ selectedCode.end }}</template>
          </p>
          <form v-if="current?.explanation" class="space-y-2" @submit.prevent="ask">
            <UFormField label="Ask about this change"
              ><UTextarea
                v-model="question"
                class="w-full"
                placeholder="What would you like to understand?" /></UFormField
            ><UButton type="submit" size="sm" :disabled="!question.trim()" :loading="busy">Ask question</UButton>
          </form>
          <div v-for="answer in currentAnswers" :key="answer.commandId" class="border-t border-default pt-3 space-y-1">
            <p class="font-medium">{{ answer.question }}</p>
            <p v-if="answer.error" class="text-warning">{{ answer.error }}</p>
            <ChangeNote v-else-if="answer.answer" :source="answer.answer.answer" />
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="reference in answer.answer?.references ?? []"
                :key="`${reference.path}:${reference.start}`"
                size="xs"
                variant="link"
                color="neutral"
                class="px-0"
                @click="jump(reference, answer.candidateSha)"
                >{{ reference.path }}:{{ reference.start }}</UButton
              >
            </div>
            <UButton
              v-if="answer.answer"
              size="xs"
              color="neutral"
              variant="link"
              class="px-0"
              @click="requestFromDiscussion(answer)"
              >Draft a change request from this answer</UButton
            >
          </div>
        </div>
      </UCard>
      <div v-if="changes" class="code-workspace min-w-0 space-y-4">
        <div class="min-w-0 space-y-3">
          <div
            v-if="prior"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
          >
            <span class="flex-1">{{
              fullChange || !delta ? 'Full task change' : `Since the previous review at ${shortSha(prior.candidateSha)}`
            }}</span>
            <UButton size="xs" color="neutral" variant="outline" :disabled="!delta" @click="fullChange = !fullChange">{{
              fullChange ? 'Show latest repair' : 'Show full task diff'
            }}</UButton>
          </div>
          <UAlert v-if="deltaError" color="warning" variant="subtle" :title="deltaError" />
          <UAlert
            v-if="prior && lastContinue?.text"
            color="info"
            variant="subtle"
            title="Guidance sent for the repair"
            description="Compare each request with the changed lines below. No request is marked addressed automatically."
          />
          <ul
            v-if="prior && feedbackItems.length"
            class="rounded-lg border border-default divide-y divide-default text-sm"
          >
            <li v-for="(item, index) in feedbackItems" :key="index" class="p-2 flex flex-wrap items-center gap-2">
              <span class="flex-1">{{ item }}</span
              ><UButton
                v-if="changedFeedbackPath(item)"
                size="xs"
                color="neutral"
                variant="link"
                @click="selectedFile = changedFeedbackPath(item)"
                >Open changed file</UButton
              >
            </li>
          </ul>
          <p class="text-xs text-muted">
            {{ visibleFiles.length }} files &middot; choose a file to read its complete diff
          </p>
          <div class="diff-workspace grid gap-3 items-start">
            <nav
              class="rounded-lg border border-default min-w-0 overflow-auto max-h-[32rem]"
              aria-label="Changed files"
            >
              <ChangedFileTree
                :files="visibleFiles"
                :selected="selectedFile"
                interactive
                @select="selectedFile = $event"
              />
              <p v-if="!visibleFiles.length" class="p-3 text-xs text-muted">
                {{
                  prior && !fullChange
                    ? 'No files changed since the previous review.'
                    : 'Nothing committed on the task branch yet.'
                }}
              </p>
            </nav>
            <div class="rounded-lg border border-default min-w-0 overflow-hidden">
              <div class="px-3 py-2 bg-elevated border-b border-default font-mono text-xs break-all">
                {{ selectedFile ?? 'Choose a file' }}
              </div>
              <UAlert v-if="diffError" color="warning" variant="subtle" :title="diffError" class="m-3" />
              <USkeleton v-else-if="selectedFile && !fileDiff" class="h-48 m-3" />
              <DiffFile
                v-else-if="fileDiff?.patch"
                :path="selectedFile ?? ''"
                :patch="fileDiff.patch"
                :selected="selectedCode"
                :highlighted="highlighted"
                @select="chooseCode"
              />
              <p v-else class="p-3 text-sm text-muted">No changed lines in this comparison.</p>
            </div>
          </div>
        </div>
        <aside class="min-w-0 grid gap-3" aria-label="Review actions">
          <UCard v-if="prior && !current?.explanation && !explanationOpen"
            ><template #header><h3 class="font-semibold">Earlier explanation</h3></template>
            <p class="text-sm text-muted">
              The explanation at {{ shortSha(prior.candidateSha) }} remains available for review and PR preparation. The
              candidate changed, so references need another look.
            </p>
            <UButton size="xs" variant="link" class="px-0 mt-2" @click="explanationOpen = true"
              >View earlier notes</UButton
            ></UCard
          >
          <UCard
            ><template #header><h3 class="font-semibold">Change requests</h3></template>
            <p class="text-xs text-muted mb-2">
              Questions do not request changes. Collect explicit guidance here, then send it in one repair round.
            </p>
            <UTextarea v-model="draftText" class="w-full" placeholder="Describe the change you want" />
            <p v-if="discussionContext" class="text-xs text-muted mt-1">From discussion: {{ discussionContext }}</p>
            <div class="flex gap-2 mt-2">
              <UButton size="xs" color="neutral" variant="outline" :disabled="!draftText.trim()" @click="addDraft"
                >Add request</UButton
              ><span v-if="selectedCode" class="text-xs text-muted self-center">With selected code</span>
            </div>
            <div v-for="(draft, index) in drafts" :key="index" class="mt-2 border border-default rounded p-2">
              <UTextarea v-model="draft.text" class="w-full" /><span v-if="draft.reference" class="text-xs text-muted"
                >{{ draft.reference.path }}:{{ draft.reference.start }}</span
              ><span v-if="draft.discussion" class="block text-xs text-muted"
                >From discussion: {{ draft.discussion }}</span
              ><UButton size="xs" color="error" variant="ghost" @click="drafts.splice(index, 1)">Remove</UButton>
            </div>
            <UButton
              v-if="drafts.length && task.needsYou?.options.includes('continue')"
              size="sm"
              class="mt-3"
              :loading="busy"
              @click="submitFeedback"
              >Continue with {{ drafts.length }} request{{ drafts.length === 1 ? '' : 's' }}</UButton
            ></UCard
          >
          <UCard v-if="current?.explanation"
            ><template #header><h3 class="font-semibold">PR description</h3></template>
            <div class="flex flex-wrap gap-2 mb-2">
              <UButton size="xs" color="neutral" variant="outline" @click="preparePr"
                >Prepare from current explanation</UButton
              ><UButton v-if="prText" size="xs" color="neutral" variant="outline" @click="prPreview = !prPreview">{{
                prPreview ? 'Edit' : 'Preview'
              }}</UButton
              ><UButton v-if="prText" size="xs" color="neutral" variant="outline" @click="copyPr"
                >Copy Markdown</UButton
              >
            </div>
            <MarkdownView v-if="prPreview" :source="prText" /><UTextarea
              v-else
              v-model="prText"
              class="w-full"
              :rows="12"
              placeholder="Prepare a description, then edit it here."
          /></UCard>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.changes-tab {
  container-type: inline-size;
}
.changes-workspace {
  display: grid;
  gap: 1rem;
  align-items: start;
}
.code-workspace,
#change-explanation {
  container-type: inline-size;
}
@container (min-width: 70rem) {
  .changes-workspace.with-explanation {
    grid-template-columns: minmax(20rem, 0.8fr) minmax(0, 1.6fr);
  }
}
@container (min-width: 44rem) {
  .diff-workspace {
    grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr);
  }
}
</style>
