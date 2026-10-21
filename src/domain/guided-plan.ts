// Owns the guided plan: normalising a proposed plan once into the exact form approval binds (pinned
// base commit, resolved verification executables, advisory file hints, full quality pass definitions) and its
// digest. The normalised plan is the contract; nothing downstream reinterprets the original input.
import { modelAssignmentSchema, modelProfileSchema, resolveModelProfile } from './model-profiles.js';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { briefSchema, validateBrief, type Brief } from './workflow.js';
import { editPolicySchema, validateEditPolicy } from '../execution/edit-policy.js';
import { commandLimits, formatBytes, planLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { gitText } from '../repository/delivery-git.js';
import type { Provider } from '../providers/types.js';
import { pinnedContext } from '../repository/repository-context.js';
import { normalizeReferences, referenceFolderSchema, type ReferenceFolder } from '../repository/reference-folders.js';
import { acceptanceExpectationsSchema, validateExpectations } from './acceptance.js';
import { normalizeWorkflowPolicy, workflowPolicySchema } from './workflow-policy.js';
import { readinessKindSchema } from './readiness.js';
import { diagnosticGrammarSchema } from './diagnostics.js';
import { checkReuseSchema } from './check-input-policy.js';
import { restorePolicySchema } from './restore-policy.js';
import { availableQualityPasses, normalizeQuality, planQualitySchema } from './quality-passes.js';

/** An approved command: an absolute executable with literal arguments, never a shell string. */
const guidedCommandSchema = z.object({
  name: z.string(),
  file: z.string(),
  args: z.array(z.string()),
  timeoutMs: z.number(),
  reuse: checkReuseSchema.exactOptional(),
  restore: restorePolicySchema.exactOptional(),
});
export type GuidedCommand = z.infer<typeof guidedCommandSchema>;

/** An acceptance command and what it must observe; see domain/acceptance.ts. */
const acceptanceCommandSchema = guidedCommandSchema.extend({
  expectedStdout: z.string().exactOptional(),
  expectations: acceptanceExpectationsSchema.exactOptional(),
});
export type AcceptanceCommand = z.infer<typeof acceptanceCommandSchema>;

/** Optional planning hints; adaptive execution is not restricted to these files. */
const sliceScopeSchema = editPolicySchema.pick({ files: true, create: true, delete: true, directories: true });

/** The execution configuration of one brief slice, in the same order as the brief's slices. */
const guidedSliceSchema = z.object({
  scope: sliceScopeSchema,
  /** Explicit mechanical checks; empty when the repository has none. Approval binds their category. */
  readiness: z.array(guidedCommandSchema.extend({ kind: readinessKindSchema })).max(planLimits.readinessChecks),
  preparation: guidedCommandSchema.exactOptional(),
  /** Suggested formatting command; native implementation owns when and how it runs. */
  formatting: guidedCommandSchema.exactOptional(),
  /** Explicit scoped diagnostic capabilities; native implementation does not use their allowlist. */
  diagnostics: z
    .array(
      guidedCommandSchema.extend({
        selection: diagnosticGrammarSchema,
        maxRuns: z.number().int().min(1).max(commandLimits.diagnosticRuns),
      }),
    )
    .max(commandLimits.diagnosticFamilies),
  /** Explicit declaration that mechanical checks can share a read-only workspace concurrently. */
  readinessConcurrency: z.number().int().min(1).max(planLimits.readinessChecks),
  validation: guidedCommandSchema,
  /**
   * Distinctly named acceptance checks, run in this order on the same artifact. Each has its own
   * timeout, the first failure stops the rest, and delivery needs every one to pass.
   */
  acceptance: z.array(acceptanceCommandSchema).min(1),
  message: z.string(),
  /** `no_change` delivers a verified unchanged head, for slices that must only be confirmed. */
  mode: z.enum(['commit', 'no_change']),
});
export type GuidedSlice = z.infer<typeof guidedSliceSchema>;

/** Guided agent turns have no deadline; a stalled turn is stopped explicitly. */
const guidedAgentSchema = modelAssignmentSchema;
export type GuidedAgent = z.infer<typeof guidedAgentSchema>;

/**
 * A normalised guided plan as approval binds it. Stored in the guided state and validated on every
 * read; the approval digest is {@link guidedPlanDigest} of exactly this value.
 */
export const guidedPlanSchema = z.object({
  /** Approval authorises adaptive native execution, independently of suggested file paths. */
  execution: z.literal('adaptive'),
  modelProfile: modelProfileSchema.exactOptional(),
  workflowPolicy: workflowPolicySchema,
  /** Selected quality passes as full definitions, so approval binds their exact instructions. */
  quality: planQualitySchema,
  preparation: guidedCommandSchema.exactOptional(),
  reviewPolicy: z.object({ arbitrator: guidedAgentSchema.exactOptional() }).exactOptional(),
  /** Set by a revision: the delivered state the revised plan continues from. */
  revision: z
    .object({
      previousVersion: z.number(),
      artifact: z.string(),
      head: z.string(),
      instructionsDigest: z.string(),
      sliceIndex: z.number(),
    })
    .exactOptional(),
  references: z.array(referenceFolderSchema).exactOptional(),
  context: z.object({
    files: z.array(z.string()),
    inventoryDigest: z.string(),
    totalFiles: z.number(),
    totalBytes: z.number(),
    exploration: z.boolean(),
  }),
  brief: briefSchema,
  workspace: z.object({
    repo: z.string(),
    base: z.string(),
    adapter: z.enum(['git', 'orca']),
    path: z.string().exactOptional(),
  }),
  implementation: guidedAgentSchema,
  review: guidedAgentSchema,
  slices: z.array(guidedSliceSchema),
});
export type GuidedPlan = z.infer<typeof guidedPlanSchema>;

/** Accept a plain object with only the named fields; their values are still unvalidated. */
function object<K extends string>(value: unknown, keys: readonly K[], label: string): Partial<Record<K, unknown>> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !keys.some(allowed => allowed === key))
  ) {
    throw new Error(`Invalid ${label}; allowed fields: ${keys.join(', ')}`);
  }
  return value;
}
function text(value: unknown, label: string, limit: number = planLimits.textBytes): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit)
    throw new Error(`${label} must be nonempty text (at most ${limit} bytes)`);
  return value;
}
/** A command's timeout; an omitted one takes `fallback`, the configured default for its kind. */
function timeout(value: unknown, fallback: number): number {
  const result = value ?? fallback;
  const { minTimeoutMs: min, maxTimeoutMs: max } = commandLimits;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`Timeout must be ${min}–${max} ms`);
  return result;
}

/** Literal command arguments: strings without NUL, bounded in their encoded size. */
function commandArgs(value: unknown): string[] {
  const invalid = new Error(
    `Command args must be an array of strings (at most ${commandLimits.argsCharacters} encoded characters)`,
  );
  if (!Array.isArray(value) || JSON.stringify(value).length > commandLimits.argsCharacters) throw invalid;
  const list: unknown[] = value;
  return list.map(arg => {
    if (typeof arg !== 'string' || arg.includes('\0')) throw invalid;
    return arg;
  });
}

/**
 * The executable of a command: `node` resolves to this Node, anything else must be an existing
 * absolute file (an `.exe` on Windows), so approval never depends on PATH lookup or a shell.
 */
function commandFile(value: unknown): string {
  const file = value === 'node' ? process.execPath : text(value, 'Command executable');
  if (
    !isAbsolute(file) ||
    !statSync(file).isFile() ||
    (process.platform === 'win32' && !file.toLowerCase().endsWith('.exe'))
  )
    throw new Error('Command file must be "node" or an absolute executable path');
  return file;
}

/** The validated `expectedStdout` and `expectations` of an acceptance command, typed. */
function observations(
  expectedStdout: unknown,
  expectations: unknown,
): Pick<AcceptanceCommand, 'expectedStdout' | 'expectations'> {
  validateExpectations(expectedStdout, expectations);
  return {
    ...(typeof expectedStdout === 'string' ? { expectedStdout } : {}),
    ...(expectations === undefined
      ? {}
      : { expectations: structuredClone(acceptanceExpectationsSchema.parse(expectations)) }),
  };
}

/**
 * Normalises a readiness, validation, preparation or acceptance command. Only an acceptance command may carry
 * `expectedStdout` and `expectations`; for any other command those fields are refused as unknown. An
 * omitted timeout takes `defaultTimeoutMs`, which preparation sets to its own, longer default.
 */
function command(value: unknown, acceptance: true, defaultName?: string): AcceptanceCommand;
function command(value: unknown, acceptance: false, defaultName?: string, defaultTimeoutMs?: number): GuidedCommand;
function command(
  value: unknown,
  acceptance: boolean,
  defaultName = acceptance ? 'Acceptance' : 'Validation',
  defaultTimeoutMs = currentSettings().defaultCheckTimeoutMs,
): AcceptanceCommand {
  const fields = ['name', 'file', 'args', 'timeoutMs', 'expectedStdout', 'expectations'] as const;
  const item = object(
    value,
    acceptance ? fields : ['name', 'file', 'args', 'timeoutMs', 'reuse', 'restore'],
    `${defaultName.toLowerCase()} command`,
  );
  if (
    item.reuse !== undefined &&
    defaultName !== 'Validation' &&
    defaultName !== 'Formatting' &&
    !defaultName.endsWith('readiness')
  )
    throw new Error('Only readiness and validation checks may declare reusable inputs');
  if (item.restore !== undefined && defaultName !== 'Preparation')
    throw new Error('Only unscoped prerequisite preparation may declare restore inputs and outputs');
  const file = commandFile(item.file);
  const args = commandArgs(item.args);
  const observed = acceptance ? observations(item.expectedStdout, item.expectations) : {};
  return {
    name: text(item.name ?? defaultName, 'Command name', planLimits.nameCharacters),
    file,
    args,
    timeoutMs: timeout(item.timeoutMs, defaultTimeoutMs),
    ...(item.reuse === undefined ? {} : { reuse: checkReuseSchema.parse(item.reuse) }),
    ...(item.restore === undefined ? {} : { restore: restorePolicySchema.parse(item.restore) }),
    ...observed,
  };
}
/** Resolves every role before approval; profile snapshots own their effective model assignments. */
function normalizeAgents(value: {
  modelProfile?: unknown;
  implementation?: unknown;
  review?: unknown;
  reviewPolicy?: unknown;
}) {
  const modelProfile =
    value.modelProfile === undefined
      ? undefined
      : resolveModelProfile(value.modelProfile, currentSettings().modelProfiles);
  const implementation = agent(modelProfile?.implementation ?? value.implementation, 'codex');
  const review = agent(modelProfile?.review ?? value.review, implementation.provider === 'codex' ? 'claude' : 'codex');
  const reviewPolicy = normalizeReviewPolicy(
    modelProfile ? (modelProfile.arbitration ? { arbitrator: modelProfile.arbitration } : {}) : value.reviewPolicy,
    implementation.provider,
  );
  if (review.provider === implementation.provider)
    throw new Error('The guided workflow requires the other provider for independent review');
  return { modelProfile, implementation, review, reviewPolicy };
}

/** An agent choice; an omitted provider takes `defaultProvider` and an omitted model is stored as `null`. */
function agent(value: unknown, defaultProvider: Provider): GuidedAgent {
  const item = object(value ?? {}, ['provider', 'model', 'effort'], 'agent');
  const provider = item.provider ?? defaultProvider;
  if (provider !== 'codex' && provider !== 'claude') throw new Error('Provider must be codex or claude');
  return modelAssignmentSchema.parse({
    provider,
    model: item.model == null ? null : text(item.model, 'Model', planLimits.nameCharacters),
    ...(item.effort === undefined ? {} : { effort: item.effort }),
  });
}

function normalizeBrief(value: unknown): Brief {
  const brief = structuredClone(object(value, ['title', 'outcome', 'criteria', 'plan', 'slices'], 'brief'));
  validateBrief(brief);
  return brief;
}

/** The repository and base commit, resolved and pinned now, so later moves of the ref never matter. */
function pinnedWorkspace(
  directory: string,
  value: unknown,
): { repo: string; base: string; adapter: 'git' | 'orca'; path: unknown } {
  const workspace = object(value, ['repo', 'base', 'adapter', 'path'], 'workspace');
  const adapter = workspace.adapter ?? 'git';
  if (adapter !== 'git' && adapter !== 'orca') throw new Error('Workspace adapter must be git or orca');
  if (adapter === 'orca' && workspace.path !== undefined) throw new Error('Orca chooses the workspace path; omit path');
  const repo = realpathSync.native(
    gitText(resolve(directory, text(workspace.repo, 'Repository')), 'rev-parse', '--show-toplevel'),
  );
  const base = gitText(
    repo,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${text(workspace.base ?? 'HEAD', 'Base ref')}^{commit}`,
  );
  return { repo, base, adapter, path: workspace.path };
}

/**
 * The selected repository context at the pinned base. A supplied inventory digest must still match,
 * so a plan proposed against an older inventory is refused rather than silently re-pinned.
 */
function normalizeContext(
  repo: string,
  base: string,
  value: unknown,
  brief: Brief,
  hasReferences: boolean,
): GuidedPlan['context'] {
  const contextInput =
    value === undefined
      ? null
      : object(value, ['files', 'inventoryDigest', 'totalFiles', 'totalBytes', 'exploration'], 'repository context');
  if (contextInput?.exploration !== undefined && typeof contextInput.exploration !== 'boolean')
    throw new Error('Context exploration must be boolean');
  const exploration = contextInput?.exploration !== false;
  if (hasReferences && !exploration) throw new Error('Reference folders require repository exploration');
  if (contextInput && !Array.isArray(contextInput.files))
    throw new Error('Repository context requires an exact files array');
  const selected = pinnedContext(
    repo,
    base,
    contextInput?.files ?? (exploration ? [] : undefined),
    `${brief.title} ${brief.outcome}`,
  );
  if (contextInput?.inventoryDigest !== undefined && contextInput.inventoryDigest !== selected.summary.inventoryDigest)
    throw new Error('Pinned repository inventory changed');
  return {
    files: selected.summary.selected,
    exploration,
    inventoryDigest: selected.summary.inventoryDigest,
    totalFiles: selected.summary.totalFiles,
    totalBytes: selected.summary.totalBytes,
  };
}

/**
 * The Git worktree destination, which must not exist yet. A revision keeps its own existing
 * workspace, so the destination it already occupies is allowed.
 */
function workspacePath(
  directory: string,
  value: unknown,
  existingWorkspace: GuidedPlan['workspace'] | undefined,
): string {
  const target = resolve(directory, text(value, 'Workspace path'));
  const path = join(realpathSync.native(dirname(target)), basename(target));
  if (existsSync(path) && (!existingWorkspace || path !== existingWorkspace.path))
    throw new Error('Workspace destination must not exist');
  return path;
}

/**
 * Optional fresh arbitration. Repair authority belongs to the shared workflow allowance;
 * an arbitrator without a provider defaults to the implementer's provider.
 */
function normalizeReviewPolicy(value: unknown, implementer: Provider): GuidedPlan['reviewPolicy'] {
  if (value === undefined) return undefined;
  const policy = object(value, ['arbitrator'], 'review policy');
  return {
    ...(policy.arbitrator === undefined ? {} : { arbitrator: agent(policy.arbitrator, implementer) }),
  };
}

/** Placeholder digests: a slice scope is validated as a policy before any artifact exists. */
const unboundPolicy = { artifact: `sha256:${'0'.repeat(64)}`, instructionsDigest: '0'.repeat(64) };

/** A slice's file scope; a no-change slice must authorise no file action at all. */
function sliceScope(value: unknown, mode: GuidedSlice['mode']): GuidedSlice['scope'] {
  if (value === undefined) return { files: [] };
  const scope = structuredClone(object(value, ['files', 'create', 'delete', 'directories'], 'file scope'));
  if (mode === 'no_change') {
    if (
      !Array.isArray(scope.files) ||
      scope.files.length ||
      scope.create !== undefined ||
      scope.delete !== undefined ||
      scope.directories !== undefined
    )
      throw new Error('No-change delivery requires scope: { files: [] }');
    return { files: [] };
  }
  const policy = { ...scope, ...unboundPolicy, workspace: true as const };
  validateEditPolicy(policy);
  // Rebuilt from the validated policy in the input's key order, which the approval digest covers.
  const { artifact: _artifact, instructionsDigest: _digest, workspace: _workspace, ...validated } = policy;
  return validated;
}

/**
 * Runs `normalize`, prefixing any error with `label`. A plan has several commands per slice, so an
 * unlabelled error would leave the planner and the person unable to tell which one to fix.
 */
function labelled<T>(label: string, normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * A slice's ordered acceptance checks: 1 to `planLimits.acceptanceChecks` commands with distinct names,
 * because the name is how a stop, a repair and the delivery gate say which check is meant. Errors name
 * the slice and, for a single command, its position.
 */
function acceptanceChecks(value: unknown, slice: number): GuidedSlice['acceptance'] {
  const label = `Slice ${slice} acceptance`;
  const max = planLimits.acceptanceChecks;
  if (!Array.isArray(value) || value.length < 1 || value.length > max)
    throw new Error(`${label}: Acceptance requires 1–${max} checks in an ordered list`);
  const list: unknown[] = value;
  const checks = list.map((item, index) =>
    labelled(list.length === 1 ? label : `${label} ${index + 1}`, () => command(item, true)),
  );
  const repeated = checks.find((check, index) => checks.findIndex(other => other.name === check.name) !== index);
  if (repeated) throw new Error(`${label}: Acceptance check names must be distinct: ${repeated.name}`);
  return checks;
}

/** Each readiness category is approved once, so a combined test command cannot be reclassified by output. */
function readinessChecks(value: unknown, slice: number): GuidedSlice['readiness'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > planLimits.readinessChecks)
    throw new Error(
      `Slice ${slice} readiness requires an ordered list of at most ${planLimits.readinessChecks} checks`,
    );
  const checks = (value as unknown[]).map((raw, index) =>
    labelled(`Slice ${slice} readiness ${index + 1}`, () => {
      const item = object(raw, ['kind', 'name', 'file', 'args', 'timeoutMs', 'reuse'], 'readiness command');
      const { kind: inputKind, ...inputCommand } = item;
      const kind = readinessKindSchema.parse(inputKind);
      return { kind, ...command(inputCommand, false, `${kind} readiness`) };
    }),
  );
  if (
    new Set(checks.map(check => check.kind)).size !== checks.length ||
    new Set(checks.map(check => check.name)).size !== checks.length
  )
    throw new Error(`Slice ${slice} readiness check kinds and names must be distinct`);
  return checks;
}

/** Resolves each diagnostic family once, binding its command and selectable argument grammar to approval. */
function diagnosticCommands(value: unknown): GuidedSlice['diagnostics'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > commandLimits.diagnosticFamilies)
    throw new Error('Too many diagnostic families');
  const result = (value as unknown[]).map(raw => {
    const { selection, maxRuns, ...input } = object(
      raw,
      ['name', 'file', 'args', 'timeoutMs', 'selection', 'maxRuns', 'reuse'],
      'diagnostic family',
    );
    const grammar = diagnosticGrammarSchema.parse(selection);
    if (
      new Set(grammar.parameters.map(item => item.name)).size !== grammar.parameters.length ||
      new Set(grammar.parameters.map(item => item.flag)).size !== grammar.parameters.length
    )
      throw new Error('Diagnostic parameters require distinct names and flags');
    const attempts = z
      .number()
      .int()
      .min(1)
      .max(commandLimits.diagnosticRuns)
      .parse(maxRuns ?? commandLimits.defaultDiagnosticRuns);
    return { ...command(input, false), selection: grammar, maxRuns: attempts };
  });
  if (new Set(result.map(item => item.name)).size !== result.length)
    throw new Error('Diagnostic family names must be distinct');
  return result;
}

function normalizeSlice(raw: unknown, number: number): GuidedSlice {
  const item = object(
    raw,
    [
      'scope',
      'readiness',
      'validation',
      'acceptance',
      'message',
      'mode',
      'preparation',
      'formatting',
      'diagnostics',
      'readinessConcurrency',
    ],
    'slice configuration',
  );
  const mode = item.mode ?? 'commit';
  if (mode !== 'commit' && mode !== 'no_change') throw new Error('Delivery mode must be commit or no_change');
  if (mode === 'no_change' && item.formatting !== undefined)
    throw new Error('No-change delivery cannot apply formatting');
  const scope = sliceScope(item.scope, mode);
  const message = text(item.message, 'Commit message', planLimits.commitMessageBytes);
  if (/Grampus-Delivery:/i.test(message))
    throw new Error('Commit message cannot contain the reserved Grampus-Delivery marker');
  return {
    scope,
    mode,
    readiness: readinessChecks(item.readiness, number),
    diagnostics: diagnosticCommands(item.diagnostics),
    readinessConcurrency: z
      .number()
      .int()
      .min(1)
      .max(planLimits.readinessChecks)
      .parse(item.readinessConcurrency ?? 1),
    ...(item.formatting === undefined
      ? {}
      : {
          formatting: labelled(`Slice ${number} formatting`, () => command(item.formatting, false, 'Formatting')),
        }),
    ...(item.preparation === undefined
      ? {}
      : {
          preparation: labelled(`Slice ${number} preparation`, () =>
            command(
              item.preparation,
              false,
              'Preparation after implementation',
              currentSettings().defaultPreparationTimeoutMs,
            ),
          ),
        }),
    validation: labelled(`Slice ${number} validation`, () => command(item.validation, false)),
    acceptance: acceptanceChecks(item.acceptance, number),
    message,
  };
}

/**
 * Normalises a proposed plan once; approval covers this exact result, including checks, paths and
 * the pinned base. Resolves the repository and base through Git and inspects references. File hints
 * are advisory and are not simulated against the pinned tree. `directory` resolves relative paths; `existingWorkspace` is
 * the workspace a revision keeps. Throws a message naming the first problem.
 */
export function normalizeGuidedPlan(
  input: unknown,
  directory = process.cwd(),
  existingWorkspace?: GuidedPlan['workspace'],
): GuidedPlan {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > planLimits.planBytes)
    throw new Error(`Guided plan exceeds ${formatBytes(planLimits.planBytes)}`);
  const value = object(
    input,
    [
      'modelProfile',
      'brief',
      'workspace',
      'implementation',
      'review',
      'reviewPolicy',
      'workflowPolicy',
      'slices',
      'context',
      'references',
      'preparation',
      'quality',
      'execution',
    ],
    'guided plan',
  );
  const workflowPolicy = normalizeWorkflowPolicy(value.workflowPolicy);
  const settings = currentSettings();
  const quality = normalizeQuality(
    value.quality,
    availableQualityPasses(settings.qualityPasses),
    settings.defaultQualityPasses,
  );
  const preparation =
    value.preparation === undefined
      ? undefined
      : command(value.preparation, false, 'Preparation', settings.defaultPreparationTimeoutMs);
  const references: ReferenceFolder[] = normalizeReferences(value.references);
  const brief = normalizeBrief(value.brief);
  const { repo, base, adapter, path: requestedPath } = pinnedWorkspace(directory, value.workspace);
  const context = normalizeContext(repo, base, value.context, brief, references.length > 0);
  const path = adapter === 'git' ? workspacePath(directory, requestedPath, existingWorkspace) : undefined;
  const { implementation, review, reviewPolicy, modelProfile } = normalizeAgents(value);
  if (!Array.isArray(value.slices) || value.slices.length !== (brief.slices?.length ?? 1))
    throw new Error('Supply one execution configuration for each approved slice (one for an unsliced brief)');
  if (value.execution !== undefined && value.execution !== 'adaptive')
    throw new Error('Guided execution must be adaptive');
  const rawSlices: unknown[] = value.slices;
  const slices = rawSlices.map((raw, index) => normalizeSlice(raw, index + 1));
  return {
    execution: 'adaptive',
    ...(modelProfile ? { modelProfile } : {}),
    brief,
    workspace: { repo, base, adapter, ...(path ? { path } : {}) },
    implementation,
    review,
    slices,
    context,
    workflowPolicy,
    quality,
    ...(preparation ? { preparation } : {}),
    ...(reviewPolicy ? { reviewPolicy } : {}),
    ...(references.length ? { references } : {}),
  };
}

/**
 * The approval digest of a normalised plan: SHA-256 of its JSON serialisation. Key order is part of
 * the serialisation, so the plan is hashed exactly as normalised and stored, never rebuilt.
 */
export function guidedPlanDigest(plan: GuidedPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
