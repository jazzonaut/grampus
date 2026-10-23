<!-- The committed diff stays central while explanation, discussion, feedback and PR copy sit beside it. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { CodeReference } from '../../../src/domain/explanation';
import type { ChangesView, DiffView, TaskDetail } from '../../../src/dashboard/types';
import { getJson, sendJson } from '../api/client';
import { shortSha } from '../presentation';
import DiffFile from './DiffFile.vue';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ task: TaskDetail }>();
const changes = ref<ChangesView | null>(null);
const delta = ref<ChangesView | null>(null);
const deltaError = ref<string | null>(null);
const error = ref<string | null>(null);
const filesMode = ref(false);
const fullChange = ref(false);
const selectedFile = ref<string | null>(null);
const selectedCode = ref<CodeReference | null>(null);
const selectedCodeVersion = ref<{ candidateSha: string; specVersion: number | null } | null>(null);
const highlighted = ref<CodeReference | null>(null);
const groupId = ref<string | null>(null);
const explanationOpen = ref(false);
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
        round => round.checks?.sha === changes.value?.sha || round.simplify?.decided?.sha === changes.value?.sha,
      )) ||
    ['ready:', 'escalate:'].some(prefix => props.task.needsYou?.reason.startsWith(prefix)),
);
const fromSha = computed(() =>
  !fullChange.value && prior.value && delta.value ? prior.value.candidateSha : (changes.value?.baseSha ?? null),
);
const visibleChanges = computed(() => (!fullChange.value && prior.value && delta.value ? delta.value : changes.value));
const visibleFiles = computed(() => {
  const files = visibleChanges.value?.files ?? [];
  if (filesMode.value || !activeGroup.value) return files;
  const paths = new Set(activeGroup.value.references.map(reference => reference.path));
  return files.filter(file => paths.has(file.path));
});
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
  async () => {
    try {
      const next = await getJson<ChangesView>(`/api/tasks/${encodeURIComponent(props.task.taskId)}/changes`);
      const moved = changes.value?.sha !== next.sha;
      changes.value = next;
      if (moved) {
        selectedFile.value = next.files[0]?.path ?? null;
        fileDiff.value = null;
        selectedCode.value = null;
        selectedCodeVersion.value = null;
        explanationOpen.value = false;
        fullChange.value = false;
      }
      error.value = null;
    } catch (failure) {
      error.value = (failure as Error).message;
    }
  },
  { immediate: true },
);
watch(
  () => [prior.value?.candidateSha, changes.value?.sha],
  async () => {
    if (!prior.value || !changes.value) {
      delta.value = null;
      deltaError.value = null;
      return;
    }
    try {
      delta.value = await getJson<ChangesView>(
        `/api/tasks/${encodeURIComponent(props.task.taskId)}/changes?from=${encodeURIComponent(prior.value.candidateSha)}`,
      );
      deltaError.value = null;
    } catch {
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
  () => [selectedFile.value, fromSha.value, changes.value?.sha],
  async () => {
    if (!selectedFile.value || !fromSha.value || !changes.value) return;
    const path = selectedFile.value;
    const from = fromSha.value;
    const sha = changes.value.sha;
    fileDiff.value = null;
    diffError.value = null;
    try {
      const result = await getJson<DiffView>(
        `/api/tasks/${encodeURIComponent(props.task.taskId)}/diff?path=${encodeURIComponent(path)}&from=${from}`,
      );
      if (selectedFile.value !== path || fromSha.value !== from || changes.value?.sha !== sha) return;
      fileDiff.value = result;
      await nextTick();
      if (highlighted.value?.path === path)
        document
          .getElementById(`code-${path}-${highlighted.value.start}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (failure) {
      if (selectedFile.value === path) diffError.value = (failure as Error).message;
    }
  },
  { immediate: true },
);
watch(visibleFiles, files => {
  if (files.length && !files.some(file => file.path === selectedFile.value))
    selectedFile.value = files[0]?.path ?? null;
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
  highlighted.value = reference;
  selectedCodeVersion.value = {
    candidateSha: candidateSha ?? changes.value?.sha ?? '',
    specVersion:
      candidateSha && candidateSha === prior.value?.candidateSha
        ? (prior.value?.specVersion ?? null)
        : (changes.value?.specVersion ?? null),
  };
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
  if (!drafts.value.length || !props.task.needsYou?.options.includes('continue')) return;
  const guidance = drafts.value
    .map(
      (item, index) =>
        `${index + 1}. ${item.text}${item.reference ? ` (${item.reference.path}:${item.reference.start}-${item.reference.end} at ${shortSha(item.candidateSha)}, spec v${item.specVersion ?? '?'})` : ''}${item.discussion ? ` [Discussion: ${item.discussion}]` : ''}`,
    )
    .join('\n');
  busy.value = true;
  try {
    await sendJson('POST', `/api/tasks/${encodeURIComponent(props.task.taskId)}/commands`, {
      kind: 'continue',
      guidance,
    });
    drafts.value = [];
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
  <div class="space-y-4 min-w-0">
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
        icon="i-lucide-panel-right-open"
        @click="explanationOpen = !explanationOpen"
        >{{ explanationOpen ? 'Close explanation' : 'Open explanation' }}</UButton
      >
      <span v-if="current?.error" class="text-xs text-warning">{{ current.error }}</span>
    </div>
    <div v-else class="space-y-2"><USkeleton class="h-5 w-1/2" /><USkeleton class="h-64" /></div>
    <div
      v-if="changes"
      class="grid gap-4 items-start"
      :class="
        explanationOpen
          ? 'md:grid-cols-[minmax(0,1fr)_minmax(15rem,18rem)]'
          : 'xl:grid-cols-[minmax(0,1fr)_minmax(19rem,25rem)]'
      "
    >
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
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex gap-1" role="group" aria-label="Change navigation">
            <UButton
              size="xs"
              :variant="filesMode ? 'outline' : 'solid'"
              color="neutral"
              :disabled="!groups.length"
              @click="filesMode = false"
              >Purposes</UButton
            >
            <UButton size="xs" :variant="filesMode ? 'solid' : 'outline'" color="neutral" @click="filesMode = true"
              >Files</UButton
            >
          </div>
          <span class="text-xs text-muted"
            >{{ visibleChanges?.files.length ?? 0 }} files · choose a file to read its complete diff</span
          >
        </div>
        <div v-if="!filesMode && groups.length" class="flex flex-wrap gap-1.5" role="group" aria-label="Purpose groups">
          <UButton
            v-for="group in groups"
            :key="group.id"
            size="xs"
            color="neutral"
            :variant="groupId === group.id ? 'solid' : 'outline'"
            @click="
              groupId = group.id;
              selectedFile = group.references[0]?.path ?? null;
            "
            >{{ group.title }} <span v-if="markers.includes(group.id)" class="ml-1">✓</span
            ><span v-else-if="needsAnotherLook.has(group.id)" class="ml-1 text-warning"
              >Needs another look</span
            ></UButton
          >
          <UButton size="xs" color="neutral" :variant="groupId === null ? 'solid' : 'outline'" @click="groupId = null"
            >All</UButton
          >
        </div>
        <div
          class="grid gap-3 items-start"
          :class="explanationOpen ? '' : 'md:grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)]'"
        >
          <nav
            class="rounded-lg border border-default overflow-auto"
            :class="explanationOpen ? 'flex max-h-20' : 'max-h-80 md:sticky md:top-2'"
            aria-label="Changed files"
          >
            <button
              v-for="file in visibleFiles"
              :key="file.path"
              type="button"
              class="text-left px-3 py-2 border-b border-default text-xs hover:bg-elevated"
              :class="[
                selectedFile === file.path ? 'bg-primary/10 font-semibold' : '',
                explanationOpen ? 'min-w-40 max-w-48 border-r' : 'w-full',
              ]"
              :title="file.oldPath ? `Renamed from ${file.oldPath}` : file.path"
              @click="selectedFile = file.path"
            >
              <span class="block truncate">{{ file.path }}</span
              ><span class="font-mono text-dimmed">{{
                file.added === null ? 'binary' : `+${file.added} -${file.deleted}`
              }}</span>
            </button>
            <p v-if="!visibleFiles.length" class="p-3 text-xs text-muted">
              No files in this view. Choose Files or show the full task diff.
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
      <aside class="min-w-0 space-y-3 xl:sticky xl:top-2" aria-label="Change explanation and review">
        <UCard v-if="explanationOpen && explanation" class="max-h-[75vh] overflow-auto">
          <template #header><h3 class="font-semibold">Why this changed</h3></template>
          <div class="space-y-3 text-sm">
            <UAlert
              v-if="!current?.explanation"
              color="warning"
              variant="subtle"
              title="Earlier candidate"
              description="This explanation refers to a previous commit. Its references may have moved."
            />
            <section
              v-for="item in [
                ['Problem', explanation.problem],
                ['Before and after', explanation.beforeAfter],
                ['Architecture', explanation.architecture],
                ['Approach', explanation.approach],
                ['Decisions', explanation.decisions],
                ['Validation', explanation.validation],
                ['Limitations', explanation.limitations],
              ]"
              :key="item[0]"
            >
              <h4 class="font-semibold">{{ item[0] }}</h4>
              <MarkdownView :source="item[1] ?? ''" />
            </section>
            <section v-if="activeGroup" class="rounded-lg border border-primary/30 p-3">
              <div class="flex justify-between gap-2">
                <h4 class="font-semibold">{{ activeGroup.title }}</h4>
                <UButton size="xs" color="neutral" variant="outline" @click="mark(activeGroup.id)">{{
                  markers.includes(activeGroup.id) ? 'Reviewed ✓' : 'Mark reviewed'
                }}</UButton>
              </div>
              <MarkdownView :source="activeGroup.purpose" />
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
            <div
              v-for="answer in currentAnswers"
              :key="answer.commandId"
              class="border-t border-default pt-3 space-y-1"
            >
              <p class="font-medium">{{ answer.question }}</p>
              <p v-if="answer.error" class="text-warning">{{ answer.error }}</p>
              <MarkdownView v-else-if="answer.answer" :source="answer.answer.answer" />
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
        <UCard v-if="prior && !current"
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
            ><UButton v-if="prText" size="xs" color="neutral" variant="outline" @click="copyPr">Copy Markdown</UButton>
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
</template>
