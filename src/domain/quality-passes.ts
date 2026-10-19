// Owns quality pass definitions: the built-in passes, validation of custom definitions, resolving the
// passes a plan selects into full definitions, and the lens assessments an independent reviewer
// returns. A plan binds the resolved definitions into its approval digest, so a later settings change
// never alters what an approved plan asks of an agent.
import { z } from 'zod';
import { commandLimits, qualityLimits, reviewLimits } from '../config/limits.js';

/**
 * A declarative quality pass. A `lens` is assessed by the independent reviewer inside its review
 * turn; an `edit` pass is a scoped implementer turn that runs before validation.
 */
export interface QualityPassDefinition {
  /** Stable kebab-case id used in plans, settings, verdicts and evidence. */
  id: string;
  /** Short human-readable name. */
  title: string;
  kind: 'lens' | 'edit';
  /** Sent verbatim to the agent; part of the approved plan. */
  instructions: string;
}

/** The `quality` section of a normalised plan: the selected passes, in the order edit passes run. */
export interface PlanQuality {
  passes: QualityPassDefinition[];
}

/** A finding inside one lens assessment; the same shape as a review finding. */
export interface LensFinding {
  severity: 'blocking' | 'suggestion';
  description: string;
  evidence: string;
}

/** The reviewer's verdict on one selected lens, part of a structured review reply. */
export interface LensAssessment {
  lens: string;
  verdict: 'pass' | 'fail';
  summary: string;
  findings: LensFinding[];
}

/**
 * A quality lens assessment of one artifact as recorded through `Checks.assess`. `reviewId` marks the
 * independent reviewer's own verdict, which must then match that review exactly; without it the
 * assessment is a person's.
 */
export interface QualityAssessment {
  pass: string;
  reviewId?: string;
  artifact: string;
  instructionsDigest: string;
  outcome: 'passed' | 'failed' | 'skipped';
  summary: string;
}

const kebabCase = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function boundedText(label: string, bytes: number) {
  return z
    .string()
    .refine(
      value => value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= bytes,
      `${label} must be nonempty text (at most ${bytes} bytes)`,
    );
}

const nonempty = (label: string) => z.string().refine(value => value.trim().length > 0, `${label} must not be empty`);

/** A quality pass id: kebab-case and bounded. */
export const qualityPassIdSchema = z
  .string()
  .max(qualityLimits.idCharacters)
  .regex(kebabCase, 'must be a kebab-case id such as "naming" or "error-handling"');

/** One quality pass definition, as accepted from settings or a plan. */
export const qualityPassDefinitionSchema = z.strictObject({
  id: qualityPassIdSchema,
  title: boundedText('Quality pass title', qualityLimits.titleBytes),
  kind: z.enum(['lens', 'edit']),
  instructions: boundedText('Quality pass instructions', qualityLimits.instructionsBytes),
});

/** A reviewer's lens assessments: at most one per lens, bounded by the number of passes a plan may select. */
export const lensAssessmentsSchema = z
  .array(
    z.strictObject({
      lens: qualityPassIdSchema,
      verdict: z.enum(['pass', 'fail']),
      summary: boundedText('Lens summary', reviewLimits.lensSummaryBytes),
      findings: z.array(
        z.strictObject({
          severity: z.enum(['blocking', 'suggestion']),
          description: nonempty('Finding description'),
          evidence: nonempty('Finding evidence'),
        }),
      ),
    }),
  )
  .max(qualityLimits.passes)
  .refine(list => new Set(list.map(item => item.lens)).size === list.length, 'Each lens may be assessed only once');

/*
 * Stored shapes. Plans and guided state are validated on every read; their bounds and id syntax were
 * enforced when the value was accepted, so these check structure only. A bound tightened later must
 * not make an existing record unreadable.
 */
const qualityPassRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['lens', 'edit']),
  instructions: z.string(),
}) satisfies z.ZodType<QualityPassDefinition, QualityPassDefinition>;

/** The `quality` section of a stored plan: full definitions, as approval bound them. */
export const planQualitySchema = z.object({ passes: z.array(qualityPassRecordSchema) }) satisfies z.ZodType<
  PlanQuality,
  PlanQuality
>;

/** A quality assessment queued in the guided state, before it is recorded as evidence. */
export const qualityAssessmentRecordSchema = z.object({
  pass: z.string(),
  reviewId: z.string().exactOptional(),
  artifact: z.string(),
  instructionsDigest: z.string(),
  outcome: z.enum(['passed', 'failed', 'skipped']),
  summary: z.string(),
}) satisfies z.ZodType<QualityAssessment, QualityAssessment>;

/** A recorded quality assessment. Its summary bound is the recorded-assessment bound. */
export const qualityAssessmentSchema = z.strictObject({
  pass: qualityPassIdSchema,
  reviewId: z.string().exactOptional(),
  artifact: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  instructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['passed', 'failed', 'skipped']),
  summary: boundedText('Assessment summary', commandLimits.assessmentBytes),
});

const findingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', enum: ['blocking', 'suggestion'] },
    description: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['severity', 'description', 'evidence'],
};

/**
 * The structured-output JSON schema of the `lenses` reply field. Providers enforce the reply schema
 * strictly, so the field must be declared there for a reviewer to be able to return it at all.
 */
export const lensAssessmentsJsonSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lens: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          summary: { type: 'string' },
          findings: { type: 'array', items: findingJsonSchema },
        },
        required: ['lens', 'verdict', 'summary', 'findings'],
      },
    },
  ],
};

function describe(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`)
    .join('; ');
}

/** Validates a reviewer's lens assessments; malformed assessments fail the review turn. */
export function parseLensAssessments(value: unknown): LensAssessment[] {
  const parsed = lensAssessmentsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid quality lens assessments: ${describe(parsed.error)}`);
  return parsed.data;
}

/** Validates an assessment before it is recorded; throws `message` with the reasons on failure. */
export function parseQualityAssessment(value: unknown, message: string): QualityAssessment {
  const parsed = qualityAssessmentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${message}: ${describe(parsed.error)}`);
  return parsed.data;
}

/** The evidence outcome a reviewer's lens verdict stands for. */
export function lensOutcome(verdict: LensAssessment['verdict']): 'passed' | 'failed' {
  return verdict === 'pass' ? 'passed' : 'failed';
}

/**
 * The built-in passes. `simplification` keeps the wording the independent review used before passes
 * were configurable, so a plan with the default selection asks the reviewer the same question.
 */
const builtIns: QualityPassDefinition[] = [
  {
    id: 'simplification',
    title: 'Simplification',
    kind: 'lens',
    instructions:
      'Explicitly assess simplification, naming, duplication and test quality of the changes. Fail when they contain avoidable complexity: unnecessary abstractions or indirection, duplication, speculative code, or tests that do not exercise meaningful behaviour. A failed assessment requires a concrete blocking finding.',
  },
  {
    id: 'naming',
    title: 'Naming',
    kind: 'lens',
    instructions:
      'Assess the names the changes introduce or alter: identifiers, files, tests, options and messages. Fail on misleading names that suggest a different behaviour, type or scope; lazy names such as data, info, handle, tmp, manager or single letters outside tiny scopes; and names inconsistent with the vocabulary the surrounding codebase already uses for the same concept. Name each instance with a better alternative.',
  },
  {
    id: 'refactor',
    title: 'Refactor',
    kind: 'edit',
    instructions:
      'Improve the structure of the code you changed in this slice without changing its behaviour: remove duplication you introduced, simplify control flow and keep functions focused. Stay within the authorized file scope. Do not add new abstractions unless they remove clear duplication. Keep every test passing and never weaken a test. If the structure is already clear, make no edits and say so.',
  },
  {
    id: 'documentation',
    title: 'Documentation',
    kind: 'edit',
    instructions:
      'Add or repair TSDoc and comments for the code you changed in this slice: document exported functions, classes and non-obvious invariants, and keep module header comments accurate. Explain why, not what; do not restate the code. Do not change behaviour. Stay within the authorized file scope. If the documentation is already adequate, make no edits and say so.',
  },
];

/** The built-in passes, frozen so no caller can change what an id resolves to. */
export const builtInQualityPasses: readonly Readonly<QualityPassDefinition>[] = Object.freeze(
  builtIns.map(pass => Object.freeze(pass)),
);

/** Every definition a plan may select by id: the built-ins, then the installation's custom passes. */
export function availableQualityPasses(custom: readonly QualityPassDefinition[] = []): QualityPassDefinition[] {
  return [...builtInQualityPasses, ...custom].map(pass => ({ ...pass }));
}

/**
 * Problems with custom definitions and a default selection, for settings validation: custom ids must
 * be unique and must not shadow a built-in, and defaults must name distinct available passes.
 */
export function qualitySettingsProblems(
  custom: readonly QualityPassDefinition[],
  defaults: readonly string[],
): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  custom.forEach((pass, index) => {
    if (builtInQualityPasses.some(builtIn => builtIn.id === pass.id))
      problems.push({ path: ['qualityPasses', index, 'id'], message: `"${pass.id}" is a built-in quality pass` });
    else if (seen.has(pass.id))
      problems.push({ path: ['qualityPasses', index, 'id'], message: `duplicate quality pass "${pass.id}"` });
    seen.add(pass.id);
  });
  const available = availableQualityPasses(custom);
  defaults.forEach((id, index) => {
    if (!available.some(pass => pass.id === id))
      problems.push({ path: ['defaultQualityPasses', index], message: `unknown quality pass "${id}"` });
    else if (defaults.indexOf(id) !== index)
      problems.push({ path: ['defaultQualityPasses', index], message: `duplicate quality pass "${id}"` });
  });
  return problems;
}

/**
 * Resolves a plan's `quality` input to full definitions. Entries are ids of available passes or full
 * definitions; a full definition is taken as given, so a revised plan keeps the exact instructions it
 * was approved with even if the settings changed since. Without `quality` the defaults apply. Throws on
 * a malformed selection, too many passes, an unknown id, an invalid definition or a repeated id.
 */
export function normalizeQuality(
  value: unknown,
  available: readonly QualityPassDefinition[],
  defaults: readonly string[],
): PlanQuality {
  const input: unknown = value === undefined ? { passes: [...defaults] } : value;
  const selection = z.strictObject({ passes: z.array(z.unknown()) }).safeParse(input);
  if (!selection.success)
    throw new Error('Invalid quality; supply { passes: [...] } with quality pass ids or full definitions');
  const entries = selection.data.passes;
  if (entries.length > qualityLimits.passes) throw new Error(`Select at most ${qualityLimits.passes} quality passes`);
  const passes = entries.map((entry): QualityPassDefinition => {
    if (typeof entry === 'string') {
      const known = available.find(pass => pass.id === entry);
      if (!known)
        throw new Error(
          `Unknown quality pass "${entry}"; available: ${available.map(pass => pass.id).join(', ') || 'none'}`,
        );
      return { id: known.id, title: known.title, kind: known.kind, instructions: known.instructions };
    }
    const parsed = qualityPassDefinitionSchema.safeParse(entry);
    if (!parsed.success) throw new Error(`Invalid quality pass definition: ${describe(parsed.error)}`);
    return parsed.data;
  });
  const ids = passes.map(pass => pass.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated) throw new Error(`Quality pass "${repeated}" is selected more than once`);
  return { passes };
}

/** The selected lenses, which the independent reviewer must assess. */
export function selectedLenses(quality: PlanQuality): QualityPassDefinition[] {
  return quality.passes.filter(pass => pass.kind === 'lens');
}

/** The selected edit passes, in the order they run. */
export function selectedEditPasses(quality: PlanQuality): QualityPassDefinition[] {
  return quality.passes.filter(pass => pass.kind === 'edit');
}
