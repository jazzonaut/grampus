import type { Task } from '../domain/workflow.js';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Store } from '../persistence/store.js';
import { Sessions, runSession, type Session } from '../execution/sessions.js';
import { gitText } from '../repository/delivery-git.js';
import { pinnedContext, searchPinnedFiles, type ContextSummary } from '../repository/repository-context.js';
import { GuidedTasks } from './guided/controller.js';
import { normalizeGuidedPlan, guidedPlanDigest, type GuidedPlan } from '../domain/guided-plan.js';
import type { Connector, Provider } from '../providers/types.js';
import { Script } from 'node:vm';
import { explorationSummary } from '../repository/repository-tools.js';
import { integrationSummary } from '../providers/integrations.js';
import { plannerProgress } from './planner-progress.js';
import { normalizeReferences, suggestReferenceFolders, type ReferenceFolder } from '../repository/reference-folders.js';
import { generateTaskTitle } from './task-title.js';
import { planLimits } from '../config/limits.js';
import { plannerPrompt } from './prompts/planner.js';

interface Kickoff {
  references: ReferenceFolder[];
  repo: string;
  base: string;
  path: string;
  adapter: 'git' | 'orca';
  provider: Provider;
  request: string;
  files: { path: string; content: string }[];
  context: ContextSummary;
}
const last = <T>(events: { type: string; data: unknown }[], type: string): T | null =>
  (events.findLast(event => event.type === type)?.data as T) ?? null;
function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value) > planLimits.textBytes
  )
    throw new Error(`${label} must be nonempty text, at most ${planLimits.textBytes} bytes`);
  return value;
}

/** The fields of a planner reply the controller overwrites; everything else is validated by normalisation. */
interface PlannerReplyPlan {
  brief?: unknown;
  workspace?: unknown;
  implementation?: unknown;
  review?: unknown;
  context?: unknown;
  references?: unknown;
}

/** Every pending question needs a nonempty answer, keyed by its id, and nothing else. */
function requireAnswers(questions: { id: string }[], answers: Record<string, string> | undefined): void {
  if (
    !answers ||
    typeof answers !== 'object' ||
    Array.isArray(answers) ||
    Object.keys(answers).length !== questions.length ||
    questions.some(question => typeof answers[question.id] !== 'string' || !answers[question.id]!.trim())
  )
    throw new Error('Answer every current planning question by id');
}

/**
 * The full repository context is resent until a turn has completed, and again after the context
 * changed; otherwise the conversation already holds it and the planner can use the tools.
 */
function needsContext(events: { sequence: number; type: string; data: unknown }[]): boolean {
  const changedContext = events.findLast(event => event.type === 'kickoff.context_changed');
  const contextChanged =
    !!changedContext &&
    changedContext.sequence > (events.findLast(event => event.type === 'turn.requested')?.sequence ?? -1);
  return (
    contextChanged ||
    !events.some(
      event =>
        event.type === 'turn.result' && (event.data as { result?: { status?: string } }).result?.status === 'completed',
    )
  );
}

/**
 * The guided plan in a planner reply. Paths, pinned base, providers, context and references are
 * chosen by the user and controller, so the reply's values for them are replaced before
 * normalisation; the generated title, if any, replaces the planner's.
 */
function planFromReply(reply: string, config: Kickoff, title: string | undefined): GuidedPlan {
  const raw = JSON.parse(reply) as PlannerReplyPlan;
  if (title && raw.brief && typeof raw.brief === 'object') (raw.brief as { title?: unknown }).title = title;
  raw.workspace = {
    repo: config.repo,
    base: config.base,
    adapter: config.adapter,
    ...(config.adapter === 'git' ? { path: config.path } : {}),
  };
  raw.implementation = { provider: config.provider };
  raw.review = { provider: config.provider === 'codex' ? 'claude' : 'codex' };
  raw.context = { files: config.files.map(file => file.path), exploration: true };
  raw.references = config.references;
  const plan = normalizeGuidedPlan(raw);
  requireValidInlineChecks(plan);
  return plan;
}

/**
 * Inline Node checks are compiled (not run) before the plan is offered for approval, so an escaping
 * mistake in generated JavaScript goes back to the planner instead of failing after approval.
 */
function requireValidInlineChecks(plan: GuidedPlan): void {
  const commands = [
    plan.preparation,
    ...plan.slices.flatMap(slice => [slice.preparation, slice.validation, slice.acceptance]),
  ];
  for (const command of commands) {
    if (!command) continue;
    if (command.file !== process.execPath) continue;
    const evalIndex = command.args.findIndex(arg => arg === '-e' || arg === '--eval');
    if (evalIndex < 0) continue;
    try {
      new Script(command.args[evalIndex + 1] ?? '');
    } catch (error) {
      throw new Error(
        `Generated inline check "${command.name}" is invalid JavaScript. Ask the planner to correct string escaping and return the complete plan. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

export class Kickoffs {
  constructor(
    private readonly store: Store,
    private readonly connector?: Connector,
  ) {}
  list() {
    return this.store
      .sessions<Session>()
      .filter(
        session =>
          !session.deletedAt && this.store.sessionEvents(session.id).some(event => event.type === 'kickoff.created'),
      )
      .map(session => this.view(session.id))
      .filter(view => !view.taskId || !this.store.get<Task>(view.taskId).deletedAt);
  }
  view(id: string) {
    return this.store.transaction(() => {
      const events = this.store.sessionEvents(id),
        original = last<Kickoff>(events, 'kickoff.created');
      const config = original
        ? { ...original, ...last<Pick<Kickoff, 'files' | 'context' | 'references'>>(events, 'kickoff.context_changed') }
        : null;
      if (!config) throw new Error('This session is not a task kickoff');
      const candidate = events.findLast(event => event.type === 'kickoff.candidate');
      const latestTurn = events.findLast(
        event =>
          event.type === 'turn.requested' ||
          event.type === 'kickoff.context_changed' ||
          (event.type === 'kickoff.message' && (event.data as { role?: string }).role === 'user'),
      );
      const plan =
        candidate && (!latestTurn || candidate.sequence > latestTurn.sequence)
          ? (candidate.data as { plan: GuidedPlan }).plan
          : null;
      const session = new Sessions(this.store).get(id);
      if (session.deletedAt) throw new Error('This planning conversation was deleted');
      const turnKey = createHash('sha256')
        .update(
          JSON.stringify({
            phase: session.phase,
            latestTurn,
            turn: events.findLast(event => event.type === 'turn.requested'),
            questions: session.lastReply?.questions,
          }),
        )
        .digest('hex');
      const referenceSuggestions = [
        ...suggestReferenceFolders(
          [
            config.request,
            ...events
              .filter(event => event.type === 'kickoff.message' && (event.data as { role?: string }).role === 'user')
              .map(event => (event.data as { text: string }).text),
          ].join('\n'),
        ),
        ...events
          .filter(event => event.type === 'reference.suggested')
          .map(event => (event.data as { data: { path: string; reason: string } }).data),
      ].filter(
        (suggestion, index, all) =>
          all.findIndex(item => item.path === suggestion.path) === index &&
          !config.references.some(item => item.path === suggestion.path),
      );
      const title =
        last<{ title: string }>(events, 'kickoff.title_generated')?.title ??
        (candidate?.data as { plan: GuidedPlan } | undefined)?.plan.brief.title ??
        null;
      return {
        id,
        title,
        session,
        turnKey,
        progress: plannerProgress(events, session),
        integrations: integrationSummary(events),
        referenceSuggestions,
        exploration: explorationSummary(events),
        config: { ...config, files: config.files.map(file => file.path) },
        messages: events
          .filter(event => event.type === 'kickoff.message')
          .map(event => ({ at: event.at, ...(event.data as { role: string; text: string }) })),
        candidate: plan,
        candidateDigest: plan ? guidedPlanDigest(plan) : null,
        error: last<{ error: string | null }>(events, 'kickoff.error')?.error ?? null,
        taskId: last<{ taskId: string }>(events, 'kickoff.converted')?.taskId ?? null,
      };
    });
  }
  inspect(input: { repo: string; request?: string; contextFiles?: unknown; base?: string }) {
    const repo = realpathSync.native(gitText(resolve(text(input.repo, 'Repository')), 'rev-parse', '--show-toplevel'));
    const base = gitText(repo, 'rev-parse', '--verify', 'HEAD^{commit}');
    if (input.base !== undefined && input.base !== base)
      throw new Error('Repository HEAD changed; inspect the repository again before planning');
    const context = pinnedContext(repo, base, input.contextFiles, input.request ?? '');
    return { repo, base, files: context.files, context: context.summary };
  }
  search(input: { repo: string; base: string; query?: string; offset?: number }) {
    const repo = realpathSync.native(gitText(resolve(text(input.repo, 'Repository')), 'rev-parse', '--show-toplevel'));
    return searchPinnedFiles(repo, input.base, input.query, input.offset);
  }
  changeContext(id: string, files: unknown, expected: string, referenceFolders?: unknown) {
    const view = this.view(id);
    if (
      view.taskId ||
      view.session.run ||
      !['idle', 'failed', 'interrupted', 'awaiting_answer'].includes(view.session.phase)
    )
      throw new Error('Context changes require a settled planning conversation');
    if (expected !== view.turnKey) throw new Error('Planning context changed; inspect the current conversation');
    const context = pinnedContext(view.config.repo, view.config.base, files);
    const references = referenceFolders === undefined ? view.config.references : normalizeReferences(referenceFolders);
    return this.store.transaction(() => {
      const current = this.view(id);
      if (
        current.turnKey !== expected ||
        current.taskId ||
        current.session.run ||
        !['idle', 'failed', 'interrupted', 'awaiting_answer'].includes(current.session.phase)
      )
        throw new Error('Planning state changed during context selection');
      this.store.appendSession(id, 'kickoff.context_changed', {
        files: context.files,
        context: context.summary,
        references,
      });
      this.store.appendSession(id, 'kickoff.error', { error: null });
      return this.view(id);
    });
  }
  create(input: {
    repo: string;
    request: string;
    provider?: Provider;
    adapter?: 'git' | 'orca';
    path?: string;
    contextFiles?: unknown;
    base?: string;
    references?: unknown;
  }): string {
    const inspected = this.inspect({ ...input, contextFiles: input.contextFiles ?? [] }),
      { repo, base } = inspected;
    const provider = input.provider ?? 'codex',
      adapter = input.adapter ?? 'git';
    if (!['codex', 'claude'].includes(provider) || !['git', 'orca'].includes(adapter))
      throw new Error('Unknown provider or workspace adapter');
    const request = text(input.request, 'Task description');
    const references = normalizeReferences(input.references ?? suggestReferenceFolders(request).map(item => item.path));
    const config: Kickoff = {
      repo,
      base,
      provider,
      adapter,
      references,
      request,
      path: input.path
        ? resolve(text(input.path, 'Workspace path'))
        : join(dirname(repo), `grampus-task-${randomUUID().slice(0, 8)}`),
      files: inspected.files,
      context: inspected.context,
    };
    return this.store.transaction(() => {
      const session = new Sessions(this.store).create(provider, repo);
      this.store.appendSession(session.id, 'kickoff.created', config);
      return session.id;
    });
  }
  /**
   * Sends one planning turn: the first request, a revision message or answers to the pending
   * questions. A turn is never replayed; a reply is adopted as the candidate plan only if no newer
   * request or context arrived while the planner was working.
   */
  async send(id: string, message?: string, answers?: Record<string, string>, signal?: AbortSignal, expected?: string) {
    const { config, needsContext, request, boundary } = this.prepareTurn(id, message, answers, expected);
    const prompt = plannerPrompt({ config, needsContext, request });
    const namingAbort = new AbortController();
    const stopNaming = () => namingAbort.abort();
    signal?.addEventListener('abort', stopNaming, { once: true });
    if (signal?.aborted) stopNaming();
    // Start the planner first so naming can never claim or delay its session.
    const planning = runSession(
      this.store,
      id,
      prompt,
      {
        repository: { repo: config.repo, base: config.base, references: config.references },
        ...(answers ? { answers } : {}),
        ...(signal ? { signal } : {}),
      },
      this.connector,
    );
    const naming = generateTaskTitle(this.store, id, config, namingAbort.signal, this.connector);
    try {
      const result = await planning;
      if (result.reply) this.store.appendSession(id, 'kickoff.message', { role: 'assistant', text: result.reply.text });
      if (result.status !== 'completed') throw new Error(result.error ?? `Planning ${result.status}`);
      if (this.view(id).session.phase === 'recovery_required')
        throw new Error('Planner shutdown is unconfirmed; recover before continuing');
      if (result.reply?.kind !== 'question') {
        if (result.reply?.kind !== 'message') throw new Error('Planner must ask questions or supply a plan');
        const title = last<{ title: string }>(this.store.sessionEvents(id), 'kickoff.title_generated')?.title;
        this.recordCandidate(id, boundary, planFromReply(result.reply.text, config, title));
      }
    } catch (error) {
      this.store.appendSession(id, 'kickoff.error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      stopNaming();
      await naming;
      signal?.removeEventListener('abort', stopNaming);
    }
    return this.view(id);
  }
  /**
   * Validates and journals the user's side of a turn in one transaction. The returned boundary is the
   * sequence of that user message; a reply is only adopted while it is still the latest request.
   */
  private prepareTurn(id: string, message?: string, answers?: Record<string, string>, expected?: string) {
    return this.store.transaction(() => {
      const view = this.view(id);
      if (view.taskId) throw new Error('This kickoff already became a task; start a new kickoff to change the plan');
      if (expected !== undefined && expected !== view.turnKey)
        throw new Error('Planning questions or state changed; inspect the current discussion before responding');
      if (view.session.run || ['running', 'stop_requested', 'recovery_required'].includes(view.session.phase))
        throw new Error('The planner is active or needs recovery; wait for confirmed settlement');
      if (view.session.phase === 'awaiting_answer') requireAnswers(view.session.lastReply!.questions, answers);
      else if (answers !== undefined) throw new Error('The planner has no pending questions');
      const events = this.store.sessionEvents(id),
        config = {
          ...last<Kickoff>(events, 'kickoff.created')!,
          ...last<Pick<Kickoff, 'files' | 'context' | 'references'>>(events, 'kickoff.context_changed'),
        };
      const first = !events.some(event => event.type === 'turn.requested');
      const context = needsContext(events);
      if (!first && !answers && !message)
        throw new Error('Supply a revision or answer the pending questions; turns are never replayed automatically');
      const request = first ? config.request : answers ? JSON.stringify(answers) : text(message, 'Message');
      this.store.appendSession(id, 'kickoff.message', { role: 'user', text: request });
      const boundary = this.store.sessionEvents(id).at(-1)!.sequence;
      this.store.appendSession(id, 'kickoff.error', { error: null });
      return { config, needsContext: context, request, boundary };
    });
  }
  /** Journals the candidate plan unless a newer request or context arrived during the turn. */
  private recordCandidate(id: string, boundary: number, plan: GuidedPlan): void {
    this.store.transaction(() => {
      const latestRequest = this.store
        .sessionEvents(id)
        .findLast(event => event.type === 'kickoff.message' && (event.data as { role?: string }).role === 'user');
      const latestContext = this.store.sessionEvents(id).findLast(event => event.type === 'kickoff.context_changed');
      if (
        latestRequest?.sequence !== boundary ||
        (latestContext && latestContext.sequence > boundary) ||
        new Sessions(this.store).get(id).phase !== 'idle'
      )
        throw new Error('A newer planning request or context arrived; inspect the current discussion');
      this.store.appendSession(id, 'kickoff.candidate', { plan });
    });
  }
  prepare(id: string, expectedDigest?: string): string {
    return this.store.transaction(() => {
      const view = this.view(id);
      if (view.taskId) throw new Error('This kickoff already has a task');
      if (view.error || !view.candidate || view.session.phase !== 'idle')
        throw new Error('Resolve planning questions/errors before preparing approval');
      if (expectedDigest !== undefined && expectedDigest !== guidedPlanDigest(view.candidate))
        throw new Error('The proposed plan changed; inspect the current proposal before preparing approval');
      // A later question/revision must not expose an older candidate as the current plan.
      const events = this.store.sessionEvents(id);
      if (
        events.findLast(event => event.type === 'kickoff.candidate')!.sequence <
        events.findLast(event => event.type === 'turn.requested')!.sequence
      )
        throw new Error('The current turn has no validated plan');
      const task = new GuidedTasks(this.store).create(view.candidate);
      this.store.appendSession(id, 'kickoff.converted', { taskId: task.id });
      this.store.append(task.id, task.version, 'guided.kickoff_linked', { sessionId: id });
      return task.id;
    });
  }
}
