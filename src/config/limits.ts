// Fixed limits. Each value bounds something that is checked before approval, recorded as evidence or
// read back during recovery, so changing one changes what a recorded spec, check or review means.
// Operational values that an installation may tune live in settings.ts.
// Rule: no new magic numbers. Add a bound here or an operational value to settings.ts.

/** One kibibyte. */
export const KiB = 1024;
/** One mebibyte. */
export const MiB = 1024 * KiB;

/** Bounds on an approved spec and its machine-readable block. */
export const specLimits = {
  /** Writing targets retain precise conditions even when a longer explanation is necessary. */
  outcomeWords: 50,
  acceptanceLabelWords: 12,
  /** Size of the spec file a worker writes. */
  bytes: 128 * KiB,
  checks: 12,
  acceptanceScenarios: 40,
  acceptanceTextLength: 4000,
  checkNameLength: 80,
  checkCommandLength: 2000,
  /** Longest single check; the default comes from settings. */
  checkTimeoutSeconds: 3600,
  protectedPaths: 50,
  pathLength: 400,
  /** Spec text shown with an approval request; longer specs are cut with a pointer to the file. */
  shownBytes: 16 * KiB,
  /** Unusable spec files the writer may correct before the user is asked. */
  automaticCorrections: 1,
} as const;

/** Bounds on a review report. Findings beyond the limit are refused rather than truncated. */
export const reviewLimits = {
  summaryWords: 40,
  evidenceWords: 60,
  bytes: 256 * KiB,
  findings: 40,
  textLength: 4000,
  /** Runnable probes include fixtures and imports, rather than only a prose finding. */
  probeSourceLength: 32 * KiB,
} as const;

/** Keep polish local: broader extractions belong in a separate task. */
export const polishLimits = { adjacentFiles: 3 } as const;

/** Bounds on a recipe. */
export const recipeLimits = {
  maxRepairRounds: 5,
  nameLength: 80,
} as const;

/** Bounds on recorded command output. */
export const checkLimits = {
  /** Named failures shown alongside the complete command log. */
  assertions: 100,
  assertionTextLength: 2000,
  /** Bytes of a check's combined output kept in its log file. */
  logBytes: 4 * MiB,
  /** Bytes of the log's tail quoted to repair workers and reviewers. */
  excerptBytes: 6 * KiB,
} as const;

/** Bounds on a single Orca or Git CLI call. */
export const processLimits = {
  outputBytes: 32 * MiB,
} as const;

/** Bounds on user-supplied text. */
export const inputLimits = {
  requestLength: 20_000,
  titleLength: 120,
  feedbackLength: 20_000,
  /** A dashboard request body: a request or feedback with room for JSON escaping. */
  bodyBytes: 256 * KiB,
} as const;

/** Bounds on an explanation and its code references, which are recorded as review evidence. */
export const explanationLimits = {
  targetWords: 250,
  summaryWords: 25,
  comparisonWords: 35,
  groupWords: 20,
  targetGroups: 5,
  answerWords: 120,
  bytes: 256 * KiB,
  textLength: 20_000,
  titleLength: 160,
  pathLength: 400,
  groups: 40,
  references: 200,
} as const;
