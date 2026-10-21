// Owns kickoffs: the planning conversation that turns a request into a proposed guided plan. A kickoff is
// a session whose `kickoff.*` events record its configuration, messages and candidate plans; converting a
// candidate creates an unapproved guided task. The planner proposes only: the controller fixes repository,
// base, workspace, providers, context, reference folders and quality passes. A turn is never replayed.
import { modelProfileSchema, resolveModelProfile } from '../domain/model-profiles.js';
import { currentSettings } from '../config/settings.js';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { RecordEvent, Store } from '../persistence/store.js';
import { Sessions, runSession } from '../execution/sessions.js';
import { gitText } from '../repository/delivery-git.js';
import { contextSummarySchema, pinnedContext, searchPinnedFiles } from '../repository/repository-context.js';
import { GuidedTasks } from './guided/controller.js';
import { normalizeGuidedPlan, guidedPlanDigest, guidedPlanSchema, type GuidedPlan } from '../domain/guided-plan.js';
import { providerSchema, type Connector, type Provider } from '../providers/types.js';
import { inlineCheckError } from './inline-checks.js';
import { explorationSummary } from '../repository/repository-tools.js';
import { integrationSummary } from '../providers/integrations.js';
import { planningUsage } from '../reporting/task-usage.js';
import { plannerProgress } from './planner-progress.js';
import {
  normalizeReferences,
  referenceFolderSchema,
  suggestReferenceFolders,
} from '../repository/reference-folders.js';
import { requestTitle } from './task-title.js';
import { planLimits } from '../config/limits.js';
import { plannerPrompt } from './prompts/planner.js';
import { validateInPlace } from '../process/boundary.js';

/** The configuration a kickoff was created with (`kickoff.created`). */
const kickoffSchema = z.object({
  references: z.array(referenceFolderSchema),
  repo: z.string(),
  base: z.string(),
  path: z.string(),
  adapter: z.enum(['git', 'orca']),
  provider: providerSchema,
  modelProfile: modelProfileSchema.exactOptional(),
  request: z.string(),
  /** The pinned files sent with the first turn. */
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  context: contextSummarySchema,
});
type Kickoff = z.infer<typeof kickoffSchema>;

// Payloads of the kickoff events this module writes and reads back. They are validated in place, so a
// candidate plan keeps the exact bytes its digest was computed from.
const contextChangedSchema = kickoffSchema.pick({ files: true, context: true, references: true });
const candidateSchema = z.object({ plan: guidedPlanSchema });
const messageSchema = z.object({ role: z.string(), text: z.string() });
const errorSchema = z.object({ error: z.string().nullable() });
const convertedSchema = z.object({ taskId: z.string() });
/** A failed dashboard worker for the conversation, journaled by the dashboard server. */
const actionFailedSchema = z.object({ action: z.string(), note: z.string() });
/** A planner tool's suggestion, journaled as the agent event `{ runId, data }`. */
const suggestedSchema = z.object({ data: z.object({ path: z.string(), reason: z.string() }) });

/** The payload of `event`, validated against `schema`. */
function payload<T>(event: RecordEvent, schema: z.ZodType<T, T>): T {
  return validateInPlace(schema, event.data, { kind: 'journal-record', source: `session_events ${event.type}` });
}

/** The payload of the latest event of `type`, or null when there is none. */
function last<T>(events: RecordEvent[], type: string, schema: z.ZodType<T, T>): T | null {
  const event = events.findLast(item => item.type === type);
  return event ? payload(event, schema) : null;
}

/**
 * The latest failed dashboard worker that nothing has superseded: a later planning event or turn means
 * the conversation moved on. Journaled, so it survives a dashboard restart that loses the in-memory job.
 */
function unresolvedActionFailure(events: RecordEvent[]): { action: string; note: string; at: string } | null {
  const latest = events.findLast(
    event =>
      event.type.startsWith('kickoff.') || event.type === 'turn.requested' || event.type === 'dashboard.action_failed',
  );
  if (latest?.type !== 'dashboard.action_failed') return null;
  const { action, note } = payload(latest, actionFailedSchema);
  return { action, note, at: latest.at };
}

/** Whether `event` is a message the user (not the planner) sent. */
function userMessage(event: RecordEvent): boolean {
  return event.type === 'kickoff.message' && payload(event, messageSchema).role === 'user';
}

/** The kickoff configuration with its latest context change applied. */
function kickoffConfig(events: RecordEvent[]): Kickoff | null {
  const original = last(events, 'kickoff.created', kickoffSchema);
  return original ? { ...original, ...last(events, 'kickoff.context_changed', contextChangedSchema) } : null;
}

/** `value` as nonempty text within `planLimits.textBytes` and without NUL; throws naming `label`. */
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

/** Every pending question needs a nonempty answer, keyed by its id, and nothing else. */
function requireAnswers(questions: { id: string }[], answers: Record<string, string> | undefined): void {
  if (
    !answers ||
    typeof answers !== 'object' ||
    Array.isArray(answers) ||
    Object.keys(answers).length !== questions.length ||
    questions.some(question => {
      const answer = answers[question.id];
      return typeof answer !== 'string' || !answer.trim();
    })
  )
    throw new Error('Answer every current planning question by id');
}

/** The part of a `turn.result` session event that says whether the turn completed. */
const turnStatusSchema = z.object({ result: z.object({ status: z.string() }) });

/**
 * The full repository context is resent until a turn has completed, and again after the context
 * changed; otherwise the conversation already holds it and the planner can use the tools.
 */
function needsContext(events: RecordEvent[]): boolean {
  const changedContext = events.findLast(event => event.type === 'kickoff.context_changed');
  const contextChanged =
    !!changedContext &&
    changedContext.sequence > (events.findLast(event => event.type === 'turn.requested')?.sequence ?? -1);
  return (
    contextChanged ||
    !events.some(
      event =>
        event.type === 'turn.result' && turnStatusSchema.safeParse(event.data).data?.result.status === 'completed',
    )
  );
}

/**
 * The guided plan in a planner reply. Paths, pinned base, providers, context, references and quality
 * passes are chosen by the user and controller, so the reply's values for them are replaced before
 * normalisation (quality passes by the configured default, changed through a revision).
 */
function planFromReply(reply: string, config: Kickoff): GuidedPlan {
  const parsed: unknown = JSON.parse(reply);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('The planner reply must be a JSON guided plan object');
  const raw: Record<string, unknown> = { ...parsed };
  raw['workspace'] = {
    repo: config.repo,
    base: config.base,
    adapter: config.adapter,
    ...(config.adapter === 'git' ? { path: config.path } : {}),
  };
  if (config.modelProfile) raw['modelProfile'] = config.modelProfile;
  else delete raw['modelProfile'];
  raw['implementation'] = config.modelProfile?.implementation ?? { provider: config.provider };
  raw['review'] = { provider: config.provider === 'codex' ? 'claude' : 'codex' };
  raw['context'] = { files: config.files.map(file => file.path), exploration: true };
  raw['references'] = config.references;
  delete raw['quality'];
  const plan = normalizeGuidedPlan(raw);
  requireValidInlineChecks(plan);
  return plan;
}

/**
 * Inline Node checks are compiled (not run) the way Node will run them before the plan is offered for
 * approval, so a broken generated script goes back to the planner instead of failing after approval.
 */
function requireValidInlineChecks(plan: GuidedPlan): void {
  const commands = [
    plan.preparation,
    ...plan.slices.flatMap(slice => [slice.preparation, slice.validation, ...slice.acceptance]),
  ];
  for (const command of commands) {
    if (!command) continue;
    // Normalisation resolves `file: 'node'` to this executable, so this covers the planner's inline checks.
    if (command.file !== process.execPath) continue;
    const error = inlineCheckError(command.args);
    if (error)
      throw new Error(
        `Generated inline check "${command.name}" is invalid JavaScript. Ask the planner to correct the script (often its string escaping) and return the complete plan. ${error.message}`,
        { cause: error },
      );
  }
}

/** Planner phases in which the conversation is settled, so its context may change. */
const settledPhases = ['idle', 'failed', 'interrupted', 'awaiting_answer'];

/**
 * Planning conversations. Every user action binds to the `turnKey` the person saw, so answers and
 * context changes never apply to a turn that has moved on.
 */
export class Kickoffs {
  constructor(
    private readonly store: Store,
    private readonly connector?: Connector,
  ) {}

  /** Live kickoffs (not deleted, and not converted into a task that was since deleted). */
  list() {
    return this.store
      .sessions()
      .filter(
        session =>
          !session.deletedAt && this.store.sessionEvents(session.id).some(event => event.type === 'kickoff.created'),
      )
      .map(session => this.view(session.id))
      .filter(view => !view.taskId || !this.store.get(view.taskId).deletedAt);
  }

  /**
   * The current state of a kickoff as the dashboard and CLI show it. `candidate` is the latest
   * proposed plan only while no newer request, message or context change has superseded it.
   */
  view(id: string) {
    return this.store.transaction(() => {
      const events = this.store.sessionEvents(id);
      const config = kickoffConfig(events);
      if (!config) throw new Error('This session is not a task kickoff');
      const candidate = events.findLast(event => event.type === 'kickoff.candidate');
      const candidatePlan = candidate ? payload(candidate, candidateSchema).plan : null;
      const latestTurn = events.findLast(
        event => event.type === 'turn.requested' || event.type === 'kickoff.context_changed' || userMessage(event),
      );
      const plan = candidate && (!latestTurn || candidate.sequence > latestTurn.sequence) ? candidatePlan : null;
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
      // The latest proposed plan names the task, even once a newer turn supersedes it; before one
      // exists, a short title from the request.
      const title = candidatePlan?.brief.title ?? requestTitle(config.request);
      return {
        id,
        title,
        session,
        turnKey,
        progress: plannerProgress(events, session),
        usage: planningUsage(this.store, id),
        integrations: integrationSummary(events),
        referenceSuggestions: this.referenceSuggestions(events, config),
        exploration: explorationSummary(events),
        config: { ...config, files: config.files.map(file => file.path) },
        messages: events
          .filter(event => event.type === 'kickoff.message')
          .map(event => ({ at: event.at, ...payload(event, messageSchema) })),
        candidate: plan,
        candidateDigest: plan ? guidedPlanDigest(plan) : null,
        error: last(events, 'kickoff.error', errorSchema)?.error ?? null,
        actionFailure: unresolvedActionFailure(events),
        taskId: last(events, 'kickoff.converted', convertedSchema)?.taskId ?? null,
      };
    });
  }

  /**
   * Reference folders worth offering: folders mentioned in the request or user messages, then those the
   * planner suggested, each once and only when not already selected. Suggestions grant no access.
   */
  private referenceSuggestions(events: RecordEvent[], config: Kickoff): { path: string; reason: string }[] {
    return [
      ...suggestReferenceFolders(
        [config.request, ...events.filter(userMessage).map(event => payload(event, messageSchema).text)].join('\n'),
      ),
      ...events
        .filter(event => event.type === 'reference.suggested')
        .map(event => payload(event, suggestedSchema).data),
    ].filter(
      (suggestion, index, all) =>
        all.findIndex(item => item.path === suggestion.path) === index &&
        !config.references.some(item => item.path === suggestion.path),
    );
  }

  /**
   * Resolves a repository and pins its current HEAD; a stated `base` must still be that HEAD. Throws
   * when the path is not a Git repository or HEAD moved since the caller last inspected it.
   */
  inspect(input: { repo: string; request?: string; contextFiles?: unknown; base?: string }) {
    const repo = realpathSync.native(gitText(resolve(text(input.repo, 'Repository')), 'rev-parse', '--show-toplevel'));
    const base = gitText(repo, 'rev-parse', '--verify', 'HEAD^{commit}');
    if (input.base !== undefined && input.base !== base)
      throw new Error('Repository HEAD changed; inspect the repository again before planning');
    const context = pinnedContext(repo, base, input.contextFiles, input.request ?? '');
    return { repo, base, files: context.files, context: context.summary };
  }

  /** Searches the pinned tree of a repository for context files. */
  search(input: { repo: string; base: string; query?: string; offset?: number }) {
    const repo = realpathSync.native(gitText(resolve(text(input.repo, 'Repository')), 'rev-parse', '--show-toplevel'));
    return searchPinnedFiles(repo, input.base, input.query, input.offset);
  }

  /**
   * Changes the selected context files and reference folders of a settled conversation. The next
   * turn resends the full context, and any candidate plan is superseded. The turn key is checked
   * again inside the write transaction, so a turn that started meanwhile is never given new context.
   */
  changeContext(id: string, files: unknown, expected: string, referenceFolders?: unknown) {
    const view = this.view(id);
    if (view.taskId || view.session.run || !settledPhases.includes(view.session.phase))
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
        !settledPhases.includes(current.session.phase)
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

  /**
   * Creates a kickoff for `request` on the repository's current HEAD and returns its session id. With
   * no explicit references, folders mentioned in the request are selected. Without a path, the Git
   * worktree destination is a fresh sibling folder of the repository. Throws for an unknown provider
   * or adapter, invalid text or a path that is not a Git repository.
   */
  create(input: {
    repo: string;
    request: string;
    provider?: Provider;
    modelProfile?: unknown;
    adapter?: 'git' | 'orca';
    path?: string;
    contextFiles?: unknown;
    base?: string;
    references?: unknown;
  }): string {
    const inspected = this.inspect({ ...input, contextFiles: input.contextFiles ?? [] }),
      { repo, base } = inspected;
    const modelProfile =
      input.modelProfile === undefined
        ? undefined
        : resolveModelProfile(input.modelProfile, currentSettings().modelProfiles);
    const provider = modelProfile?.planning.provider ?? input.provider ?? 'codex',
      adapter = input.adapter ?? 'git';
    if (!['codex', 'claude'].includes(provider) || !['git', 'orca'].includes(adapter))
      throw new Error('Unknown provider or workspace adapter');
    const request = text(input.request, 'Task description');
    const references = normalizeReferences(input.references ?? suggestReferenceFolders(request).map(item => item.path));
    const config: Kickoff = {
      repo,
      base,
      provider,
      ...(modelProfile ? { modelProfile } : {}),
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
      const session = new Sessions(this.store).create(
        provider,
        repo,
        modelProfile?.planning.model ?? null,
        undefined,
        modelProfile?.planning.effort,
      );
      this.store.appendSession(session.id, 'kickoff.created', config);
      return session.id;
    });
  }

  /**
   * Sends a planning request, allowing a bounded fresh correction of a completed invalid proposal.
   * A turn is never replayed; a reply is adopted as the candidate plan only if no newer
   * request or context arrived while the planner was working. A request refused before the turn
   * (stale `expected`, an active planner, missing answers) throws and sends nothing; failures of the
   * turn or its reply are journaled as the kickoff error rather than thrown, so the conversation shows them.
   */
  async send(id: string, message?: string, answers?: Record<string, string>, signal?: AbortSignal, expected?: string) {
    const prepared = this.prepareTurn(id, message, answers, expected);
    const { config, request, boundary } = prepared;
    let rejection = prepared.rejection;
    try {
      for (let correction = 0; ; correction++) {
        if (signal?.aborted) throw new Error('Planning interrupted');
        const prompt = plannerPrompt({
          config,
          needsContext: correction === 0 ? prepared.needsContext : !this.view(id).session.providerSessionId,
          request,
          rejection,
          timings: this.store.checkTimings(config.repo, config.base),
        });
        // runSession claims synchronously before its first await. Fence and journal a correction
        // with that claim; provider work starts only after this synchronous transaction commits.
        const { planning } = this.store.transaction(() => {
          if (correction > 0) {
            this.requireCurrentProposal(id, boundary);
            this.store.appendSession(id, 'kickoff.error', { error: rejection });
            this.store.appendSession(id, 'kickoff.plan_correction_requested', { correction, error: rejection });
            this.store.appendSession(id, 'kickoff.error', { error: null });
          }
          return {
            planning: runSession(
              this.store,
              id,
              prompt,
              {
                repository: { repo: config.repo, base: config.base, references: config.references },
                ...(answers && correction === 0 ? { answers } : {}),
                ...(signal ? { signal } : {}),
              },
              this.connector,
            ),
          };
        });
        const result = await planning;
        if (result.reply)
          this.store.appendSession(id, 'kickoff.message', { role: 'assistant', text: result.reply.text });
        if (result.status !== 'completed') throw new Error(result.error ?? `Planning ${result.status}`);
        if (this.view(id).session.phase === 'recovery_required')
          throw new Error('Planner shutdown is unconfirmed; recover before continuing');
        if (result.reply?.kind === 'question') break;
        if (result.reply?.kind !== 'message') throw new Error('Planner must ask questions or supply a plan');
        this.requireCurrentProposal(id, boundary);
        let plan: GuidedPlan;
        try {
          plan = planFromReply(result.reply.text, config);
        } catch (error) {
          rejection = error instanceof Error ? error.message : String(error);
          if (correction >= planLimits.plannerCorrections) throw error;
          continue;
        }
        this.recordCandidate(id, boundary, plan);
        break;
      }
    } catch (error) {
      this.store.appendSession(id, 'kickoff.error', { error: error instanceof Error ? error.message : String(error) });
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
      if (view.session.phase === 'awaiting_answer') {
        const questions = view.session.lastReply?.questions;
        if (!questions) throw new Error('The pending planning questions are missing; recover the conversation');
        requireAnswers(questions, answers);
      } else if (answers !== undefined) throw new Error('The planner has no pending questions');
      const events = this.store.sessionEvents(id),
        config = kickoffConfig(events);
      if (!config) throw new Error('This session is not a task kickoff');
      const first = !events.some(event => event.type === 'turn.requested');
      const context = needsContext(events);
      if (!first && !answers && !message)
        throw new Error('Supply a revision or answer the pending questions; turns are never replayed automatically');
      const request = first ? config.request : answers ? JSON.stringify(answers) : text(message, 'Message');
      this.store.appendSession(id, 'kickoff.message', { role: 'user', text: request });
      const boundary = this.store.sessionEvents(id).at(-1)?.sequence;
      if (boundary === undefined) throw new Error('The planning message was not journaled');
      this.store.appendSession(id, 'kickoff.error', { error: null });
      return { config, needsContext: context, request, boundary, rejection: view.error };
    });
  }

  /** Fences adoption and correction alike on the original request and confirmed idle settlement. */
  private requireCurrentProposal(id: string, boundary: number): void {
    const events = this.store.sessionEvents(id);
    const latestRequest = events.findLast(userMessage);
    const latestContext = events.findLast(event => event.type === 'kickoff.context_changed');
    if (
      latestRequest?.sequence !== boundary ||
      (latestContext && latestContext.sequence > boundary) ||
      new Sessions(this.store).get(id).phase !== 'idle'
    )
      throw new Error('A newer planning request or context arrived; inspect the current discussion');
  }

  /** Journals the candidate plan unless a newer request or context arrived during the turn. */
  private recordCandidate(id: string, boundary: number, plan: GuidedPlan): void {
    this.store.transaction(() => {
      this.requireCurrentProposal(id, boundary);
      this.store.appendSession(id, 'kickoff.candidate', { plan });
    });
  }

  /**
   * Converts the current candidate into an unapproved guided task and returns its id. `expectedDigest`
   * is the candidate digest the person inspected; a changed proposal is refused. Conversion and the
   * `kickoff.converted` link commit together, so a kickoff becomes at most one task.
   */
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
      const candidate = events.findLast(event => event.type === 'kickoff.candidate'),
        turn = events.findLast(event => event.type === 'turn.requested');
      if (!candidate || !turn || candidate.sequence < turn.sequence)
        throw new Error('The current turn has no validated plan');
      const task = new GuidedTasks(this.store).create(view.candidate);
      this.store.appendSession(id, 'kickoff.converted', { taskId: task.id });
      this.store.append(task.id, task.version, 'guided.kickoff_linked', { sessionId: id });
      return task.id;
    });
  }
}
