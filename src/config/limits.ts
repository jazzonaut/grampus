// Fixed limits. Each value bounds something that is checked before approval, recorded as evidence,
// compared during recovery, or stops work before inference. They are deliberately not overridable:
// changing one changes what an approval digest, a check record or a recovery comparison means.
// Operational values that may be tuned per installation live in settings.ts.
// Rule: no new magic numbers. Add a bound here or an operational value to settings.ts.
// The native supervisor (process/native/check.cs) keeps its own C# constants: a 2 MiB combined output
// cap, a 100 ms job drain and a 5 s termination grace. Change them there and in docs together.

/** One kibibyte. */
export const KiB = 1024;
/** One mebibyte. */
export const MiB = 1024 * KiB;

/** Fixed bounds for approved model profiles, comparison membership and export attachments. */
export const profileLimits = {
  profiles: 32,
  comparisonMinimumRuns: 2,
  comparisonRuns: 8,
  qualityAssignments: 6,
  exportAttachmentBytes: 64 * MiB,
} as const;

/** Render a limit for messages and prompts, e.g. `256 KiB` or `1 MiB`, so text cannot drift from the value. */
export function formatBytes(bytes: number): string {
  if (bytes >= MiB && bytes % MiB === 0) return `${bytes / MiB} MiB`;
  if (bytes >= KiB && bytes % KiB === 0) return `${bytes / KiB} KiB`;
  return `${bytes} bytes`;
}

/** Bounds on an approved guided plan. All are checked when the plan is normalised, before approval. */
export const planLimits = {
  /** Encoded size of a whole guided plan proposal; stops oversized planner output before parsing. */
  planBytes: 1 * MiB,
  /** Free text in plans, kickoff messages and manual assessment summaries. */
  textBytes: 16_000,
  /** Characters in a command name or model name. */
  nameCharacters: 200,
  /** Bytes in a delivery commit message, checked at approval and again before the Git write. */
  commitMessageBytes: 8192,
  /** Ordered slices in one brief; each is a separate verified delivery. */
  slices: 64,
  /** Ordered acceptance checks in one slice; each runs under its own timeout and all must pass. */
  acceptanceChecks: 8,
  /** One explicit check for each mechanical readiness kind, before behavioural validation. */
  readinessChecks: 3,
} as const;

/** Inclusive ranges for an approved workflow policy. Settings defaults must also fall inside them. */
export const workflowPolicyBounds = {
  /** Mechanical readiness repairs per slice, never replenished by behavioural repairs or retries. */
  readinessRounds: { min: 0, max: 10 },
  /** Shared behavioural validation, acceptance and review repair rounds per slice. */
  repairRounds: { min: 0, max: 10 },
  /** Turns before a fresh provider conversation. */
  maxSessionTurns: { min: 1, max: 50 },
  /** Observed input tokens before a fresh provider conversation. */
  maxContextTokens: { min: 8000, max: 1_000_000 },
  /** Total requested provider turns across the task, including linked planning and every version. */
  maxTaskTurns: { min: 1, max: 1000 },
  /** Total observed provider tokens across the task. Zero disables the token gate only. */
  maxTaskTokens: { min: 0, max: 1_000_000_000 },
} as const;

/**
 * Native editing scope. File and scope sizes are checked at plan approval and again before editing,
 * so an approved plan can always be executed; payload bounds apply to every authorised tool call.
 */
export const editLimits = {
  /** Largest regular UTF-8 file in an edit or delete scope. */
  fileBytes: 1 * MiB,
  /** Total existing bytes across one slice's edit and delete scope. */
  scopeBytes: 4 * MiB,
  /** Largest single editable file inlined in a Codex prompt when exploration can page the remainder. */
  inlineFileBytes: 64 * KiB,
  /** Text in one Edit or Write call, or one patch diff; bounds what a single authorised call can carry. */
  payloadBytes: 256 * KiB,
  /** Encoded size of a structured final reply accepted through the Claude tool hook. */
  structuredReplyBytes: 64 * KiB,
  /** Distinct paths in one edit policy, and file changes in one patch. */
  paths: 64,
  /** Characters in one repository-relative path of an edit policy. */
  pathCharacters: 512,
  /** Characters in the scoped delete tool's path argument, enforced by its schema before policy checks. */
  deletePathCharacters: 32_768,
} as const;

/** Supervised commands: checks, preparation, acceptance, delivery and implementation turns. */
export const commandLimits = {
  /** Shortest deadline for a supervised command. */
  minTimeoutMs: 100,
  /** Longest deadline for a supervised command; zero (no deadline) is allowed only where stated. */
  maxTimeoutMs: 600_000,
  /** Deadline of the delivery commit. Part of the delivery request, which recovery compares exactly. */
  deliveryTimeoutMs: 120_000,
  /** Characters in a check name. */
  nameCharacters: 200,
  /** JSON-encoded characters of a command's literal arguments. */
  argsCharacters: 24_000,
  /** Bytes of each output stream retained in the journal as the check preview; full logs stay on disk. */
  previewBytes: 64 * KiB,
  /** Bytes of one supervisor protocol line or completion receipt accepted from the native host. */
  protocolBytes: 4096,
  /** Bytes in a recorded quality assessment summary (any lens, not only simplification). */
  assessmentBytes: 16 * KiB,
} as const;

/** Acceptance expectations, checked at approval. */
export const acceptanceLimits = {
  /** Expected stdout, expected stderr or expected file content. */
  textBytes: 64 * KiB,
  /** Encoded size of all additional expectations. */
  expectationsBytes: 128 * KiB,
  /** File expectations in one acceptance command. */
  files: 64,
  /** Characters in a file expectation path. */
  pathCharacters: 4096,
} as const;

/** Paging and excerpts of check output. Excerpts feed repair prompts, so they bound prompt growth. */
export const checkOutputLimits = {
  /** Default characters per check log page. */
  pageCharacters: 12_000,
  /** Largest check log page; the dashboard reads pages of this size. */
  maxPageCharacters: 16_000,
  /** Read buffer when paging durable logs; keeps memory bounded for any log size. */
  readBufferBytes: 64 * KiB,
  /** Logs up to this size are summarised whole; larger ones as preview head plus tail. */
  summaryWholeBytes: 64_000,
  /** Bytes read from the end of a large log for its summary. */
  summaryTailBytes: 16_000,
  /** Characters of the journal preview kept at the start of a large log summary. */
  summaryHeadCharacters: 4000,
  /** Default excerpt length. */
  excerptCharacters: 5000,
  /** Excerpt of a failure reason, expectation or previous reply in repair feedback. */
  feedbackCharacters: 2000,
  /** Stdout excerpt in repair feedback. */
  feedbackStdoutCharacters: 4000,
  /** Stderr excerpt in repair feedback. */
  feedbackStderrCharacters: 6000,
} as const;

/** Independent review. History limits stop before inference instead of silently omitting findings. */
export const reviewLimits = {
  /** Earlier verdicts for one slice; beyond this the task stops for a revision. */
  historyVerdicts: 12,
  /** Encoded size of the earlier verdicts sent to the reviewer; part of the review turn's prompt budget. */
  historyBytes: 64 * KiB,
  /** Bytes in a reviewer's summary of one quality lens assessment. */
  lensSummaryBytes: 12_000,
} as const;

/**
 * Quality pass definitions. A plan binds the full definitions into its approval digest and agents
 * receive the instructions verbatim, so these bound both the approved plan and every prompt.
 */
export const qualityLimits = {
  /** Quality passes selected in one plan, and lens assessments in one review verdict. */
  passes: 6,
  /** Custom quality pass definitions in `config.json`. */
  customPasses: 16,
  /** Characters in a quality pass id. */
  idCharacters: 40,
  /** Bytes in a quality pass title. */
  titleBytes: 120,
  /** Bytes in a quality pass's instructions. */
  instructionsBytes: 4 * KiB,
} as const;

/** Provider turn bounds enforced by the controller. */
export const providerLimits = {
  /** Models requested per Codex catalogue page. */
  modelListPage: 100,
  /** Maximum catalogue pages, including empty pages with a continuing cursor. */
  modelListPages: 10,
  /** Maximum models accepted from one provider catalogue. */
  modelListTotal: 1000,
  /** Repository tool calls in one Codex turn. */
  turnToolCalls: 512,
  /** Native patch items tracked in one Codex turn. */
  turnPatchItems: 64,
  /** Codex MCP server status entries requested per page. */
  mcpStatusPage: 100,
  /** Codex MCP server status entries read in total; stops an endless cursor. */
  mcpStatusTotal: 1000,
  /** Claude agent turns within one conversation turn. */
  claudeMaxTurns: 64,
} as const;

/** Repository snapshots and reads. Snapshot bounds are part of what an artifact digest can cover. */
export const repositoryLimits = {
  /** Largest file in a snapshot, a repository read, a reference folder or a delivery blob. */
  fileBytes: 32 * MiB,
  /** Output buffer for snapshot Git plumbing. */
  gitOutputBytes: 32 * MiB,
  /** Output buffer for delivery Git plumbing: one largest file plus framing. */
  deliveryGitOutputBytes: 34 * MiB,
  /** Bytes of blob content verified per delivery `cat-file --batch` call. */
  deliveryBlobBatchBytes: 8 * MiB,
  /** Framing allowance per blob in a delivery verification batch. */
  deliveryBlobOverheadBytes: 100,
  /** Retained change evidence (diff content) in one snapshot. */
  changeEvidenceBytes: 4 * MiB,
  /** Paths listed per page of review coverage and changed files. */
  reviewListPage: 100,
  /** Pinned trees kept in the in-memory inventory cache. */
  cacheEntries: 4,
  /** Total estimated size of the in-memory inventory cache. */
  cacheBytes: 64 * MiB,
  /** Largest directories reported in an inventory summary. */
  summaryDirectories: 50,
  /** Suggested context files for a new plan. */
  suggestedFiles: 64,
  /** Characters in a pinned inventory search query. */
  searchQueryCharacters: 512,
  /** Matches per page of a pinned inventory search. */
  searchPage: 100,
} as const;

/**
 * Everything Grampus sends in one provider turn. Every prompt part (controller text, repository
 * instructions, selected context, changed files, diffs and Codex's editable contents) shares this one
 * budget, filled in priority order; what does not fit is deferred to the paging repository tools, or the
 * turn is refused before dispatch. It is sized for the smallest provider limits: Codex refuses turn input
 * over 1,048,576 characters (UTF-8 bytes bound characters), and at a conservative 3 bytes per token it
 * uses under half of a 200k-token Claude context window, leaving room for the agent to work.
 */
export const promptLimits = {
  /** UTF-8 bytes of one turn prompt. */
  turnBytes: 256 * KiB,
} as const;

/**
 * Context sent inline to planners and reviewers. Checked when context is selected and again at review.
 * The total leaves the rest of `promptLimits.turnBytes` for the controller's own text, so selected
 * context that passes approval always fits a starting prompt.
 */
export const contextLimits = {
  /** Total JSON-encoded bytes of selected or required context. */
  bytes: 160 * KiB,
  /** Bytes of one context file. */
  fileBytes: 128 * KiB,
  /** Files in selected or required context. */
  files: 256,
} as const;

/** Reference folders: read-only roots approved with the plan. */
export const referenceLimits = {
  /** Reference folders per plan. */
  folders: 16,
  /** Files in one plain reference folder inventory. */
  files: 100_000,
} as const;

/** The shared repository tools. Every result is journaled, so each page is bounded. */
export const repositoryToolLimits = {
  /** Characters of tool text arguments. */
  argumentCharacters: 512,
  /** Paths, changed files or checks per page. */
  listPage: 100,
  /** Default and largest character page. */
  pageCharacters: 12_000,
  /** Default line page. */
  pageLines: 200,
  /** Largest line page. */
  maxPageLines: 400,
  /** Encoded bytes of one page of content. */
  resultBytes: 24_000,
  /** Files scanned per search page. */
  searchFiles: 128,
  /** Bytes scanned per search page; larger files are skipped and must be read directly. */
  searchBytes: 4 * MiB,
  /** Matches returned per search page. */
  searchMatches: 50,
  /** Matches reported per file before it is marked as having more. */
  searchFileMatches: 10,
  /** Characters of each reported match line. */
  matchCharacters: 300,
  /** Largest installed dependency source file. */
  dependencyFileBytes: 4 * MiB,
  /** Characters in a dependency search query. */
  dependencyQueryCharacters: 256,
  /** Matches per dependency search page. */
  dependencyMatches: 10,
  /** Characters of context either side of a dependency match. */
  dependencySnippetCharacters: 160,
  /** Claude repository MCP server call timeout. */
  mcpTimeoutMs: 30_000,
  /** Claude scoped delete tool call timeout. */
  deleteToolTimeoutMs: 5000,
} as const;

/** Dashboard server. */
export const serverLimits = {
  /** Request body size for the API and for a worker request. */
  requestBytes: 1 * MiB,
  /** Trailing characters of worker stderr kept as the job error. */
  workerErrorCharacters: 16_000,
  /** Characters of a failed worker's message journaled as `dashboard.action_failed`. */
  workerFailureCharacters: 2000,
  /** Settled dashboard jobs are dropped from memory after this long; their failures stay in the journal. */
  settledJobRetentionMs: 5 * 60_000,
  /** Characters of the provisional task title derived from the request before a plan exists. */
  provisionalTitleCharacters: 60,
  /** Characters of an event note in a dashboard timeline entry. */
  eventNoteCharacters: 1200,
  /** Characters of the task note in the dashboard task view. */
  stateNoteCharacters: 3000,
  /** A failed-check note longer than this is replaced by the check's summary in the dashboard task view. */
  stateNoteSummaryThreshold: 4000,
  /** Characters of a tool argument shown in live planner progress. */
  progressTextCharacters: 180,
  /** Node HTTP request timeout. */
  requestTimeoutMs: 15_000,
  /** Node HTTP header timeout. */
  headersTimeoutMs: 10_000,
  /** Ephemeral ports tried for a dashboard on port 0 while the system keeps assigning ones browsers refuse. */
  ephemeralPortAttempts: 16,
} as const;

/** Process control. These bound startup, shutdown and IPC so that no wait is unbounded. */
export const processLimits = {
  /** Default deadline for short helper commands such as version probes. */
  commandTimeoutMs: 15_000,
  /** Output buffer for short helper commands. */
  commandOutputBytes: 1 * MiB,
  /** Largest JSON-RPC line from Codex app-server. */
  rpcLineBytes: 1 * MiB,
  /** Default JSON-RPC request deadline. */
  rpcRequestTimeoutMs: 15_000,
  /** JSON-RPC shutdown: terminate the server after this delay. */
  rpcTerminateMs: 1000,
  /** JSON-RPC shutdown: force-kill after this delay. */
  rpcKillMs: 2000,
  /** JSON-RPC shutdown: report an unconfirmed exit after this delay. */
  rpcShutdownMs: 4000,
  /** Claude shutdown: force-kill after this delay. */
  claudeKillMs: 3000,
  /** Claude shutdown: report an unconfirmed exit after this delay. */
  claudeShutdownMs: 5000,
  /** Grace after a stop request before a session turn settles as stopped. */
  stopGraceMs: 5000,
  /** Interval at which running actions poll the journal for a persisted stop request. */
  stopPollMs: 250,
  /** Check host: deadline for the supervisor to receive its request. */
  supervisorStartupMs: 20_000,
  /** Check host: allowance after a check's own deadline, a result or a stop before the supervisor is killed. */
  supervisorSettleMs: 15_000,
  /** Controller-side allowance for the supervisor to report after startup, a result or a stop. */
  supervisorReportMs: 20_000,
  /** Process identity query deadline. */
  identityTimeoutMs: 5000,
  /** Process identity query output size. */
  identityOutputBytes: 4096,
  /**
   * SQLite busy timeout for journal connections: how long a writer waits for another process's write
   * transaction. Parallel guided tasks write from separate processes, so it must exceed the slowest
   * work done while holding the write lock (process identity queries during explicit recovery, each up
   * to `identityTimeoutMs`) for a concurrent task's write to wait rather than fail.
   */
  journalBusyMs: 15_000,
  /** Deadline for ordinary Git commands. */
  gitTimeoutMs: 30_000,
  /** Deadline for creating a worktree, which checks out every file. */
  worktreeCreateTimeoutMs: 300_000,
  /** Output buffer for workspace and Orca commands. */
  toolOutputBytes: 4 * MiB,
  /** Deadline for one Orca CLI call. */
  orcaTimeoutMs: 120_000,
} as const;

/**
 * Validation of data crossing a process, file or network boundary (`process/boundary.ts`). These bound
 * what a schema failure or an unrecognised message may write into errors and the journal.
 */
export const boundaryLimits = {
  /** Schema issues named in one boundary error; the rest are counted. */
  reportedIssues: 8,
  /** Characters of a sanitised excerpt of an unrecognised or malformed message. */
  excerptCharacters: 600,
  /** Characters kept from each string value inside an excerpt. */
  excerptStringCharacters: 80,
  /** Object and array nesting kept inside an excerpt. */
  excerptDepth: 4,
  /** Entries kept from each object or array inside an excerpt. */
  excerptEntries: 12,
  /** Distinct unrecognised provider message types journaled per provider session; later ones are counted. */
  unrecognizedMessageTypes: 32,
} as const;

/**
 * Integration health (`health/`). These bound what a health check may wait for and write into the
 * journal; the check interval itself is the `healthCheckIntervalMs` setting.
 */
export const healthLimits = {
  /** Deadline for the Claude handshake (`accountInfo` and MCP status) and for each health command. */
  handshakeTimeoutMs: 30_000,
  /** Characters of one capability detail; longer text is shortened after secrets are redacted. */
  detailCharacters: 240,
  /** Hex characters of the overall health fingerprint. */
  fingerprintCharacters: 16,
  /** MCP server names listed in one capability detail; the rest are counted. */
  mcpServersListed: 8,
} as const;

/** Stall detection in the dashboard server. The silence threshold itself is the `stallWarningMs` setting. */
export const stallLimits = {
  /** How often the dashboard server looks for silent running sessions and checks. */
  scanIntervalMs: 15_000,
} as const;

/** The dashboard view model and its v1 API (`server/view-model/`, `server/api-v1.ts`). */
export const viewModelLimits = {
  /** Recent repair decisions shown on the running task. Full history remains in the journal. */
  repairDecisions: 12,
  /** Bounded observed check/review results shown for one repair attempt. */
  repairResults: 12,
  /** Timeline entries in one page when the request names no limit. */
  timelinePageEntries: 50,
  /** Largest timeline page a request may ask for. */
  timelineMaxPageEntries: 200,
  /** Latest timeline entries embedded in a task detail. */
  recentTimelineEntries: 3,
  /** Latest verified deliveries listed on the overview. */
  recentDeliveries: 10,
  /** Overviews and details cached by journal revision; the oldest is dropped first. */
  cachedViews: 16,
  /** Local Orca worktrees offered as repository choices on New task; more are counted, not listed. */
  orcaWorktreeChoices: 100,
} as const;

/** Display-only live working tree observations; never approval or verification evidence. */
export const monitoringLimits = {
  /** Maximum combined Git path-list output before the observation is unavailable. */
  pathBytes: 1 * MiB,
  /** Changed paths included in one observation; additional paths are counted explicitly. */
  paths: 200,
  /** One selected patch; larger patches are explicitly marked as truncated. */
  patchBytes: 128 * KiB,
  /** Maximum rendered patch lines, to keep a selected diff from creating unbounded browser nodes. */
  patchLines: 1200,
} as const;

/** Human guidance is bounded before it enters a provider prompt or a durable dispatch intent. */
export const guidanceLimits = {
  /** Maximum UTF-8 bytes in one human message. */
  messageBytes: 4000,
  /** Queued messages plus the batch assigned to the active step. */
  pendingMessages: 8,
  /** Recent messages on the task screen; the complete history remains in the journal. */
  historyMessages: 24,
} as const;

/** Bounded text sent to the optional Orca desktop; never provider or verification evidence. */
export const orcaPresentationLimits = {
  titleCharacters: 120,
  commentCharacters: 300,
} as const;

/** Local desktop discovery is bounded before any access token is used. */
export const desktopLimits = {
  discoveryBytes: 16 * KiB,
  responseBytes: 16 * KiB,
};

/** Display-only activity pages and previews; these never establish workflow evidence. */
export const observabilityLimits = {
  pageEvents: 400,
  maxPageEvents: 1000,
  previewCharacters: 600,
  activityNameCharacters: 120,
  cursorCharacters: 512,
} as const;
