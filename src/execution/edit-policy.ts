// Owns the exact edit policy of a native editing turn: validating it, preparing and presenting the scoped
// files, deciding each provider file tool call or patch, and verifying the finished turn against it.
// Decisions fail closed and are journaled before any file I/O; it never grants a shell or Git access.
import { lstatSync, readFileSync, realpathSync, unlinkSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import { parseReply, type AgentEvent } from '../providers/types.js';
import { editLimits, formatBytes } from '../config/limits.js';
import { codexFileChangeSchema } from '../providers/codex-protocol.js';
import { z } from 'zod';
import { systemErrorCode } from '../process/boundary.js';
import { requireSnapshotVisible } from '../repository/visible-path.js';
import { PromptBudget, promptBytes } from '../providers/prompt-budget.js';
import { directoryScopeSchema, directoryAllows, isEditablePath as editablePath } from './directory-scope.js';

/**
 * The shape of an edit policy, as read from a CLI policy file or a journal record. Semantic rules
 * (path syntax, protected paths, limits, digests) are enforced by `validateEditPolicy`.
 */
export const editPolicySchema = z.strictObject({
  artifact: z.string(),
  instructionsDigest: z.string(),
  files: z.array(z.string()),
  create: z.array(z.string()).exactOptional(),
  delete: z.array(z.string()).exactOptional(),
  directories: z.array(directoryScopeSchema).min(1).max(editLimits.directories).exactOptional(),
});
export type EditPolicy = z.infer<typeof editPolicySchema>;

/** Claude's name for the in-process scoped deletion tool; offered only when deletions are approved. */
export const deleteFileTool = 'mcp__grampus_files__delete_file';

// Native Claude file tool inputs are agent-supplied. Each tool has a strict schema; the path is checked
// against the policy first so a denial names the most relevant reason.
const filePathSchema = z.looseObject({ file_path: z.string() });
const toolText = z
  .string()
  .refine(text => !text.includes('\0') && Buffer.byteLength(text) <= editLimits.payloadBytes, 'Unbounded text');
const fileToolSchemas: Partial<Record<string, z.ZodType>> = {
  Read: z.strictObject({ file_path: z.string(), offset: z.unknown().optional(), limit: z.unknown().optional() }),
  Write: z.strictObject({ file_path: z.string(), content: toolText }),
  Edit: z.strictObject({
    file_path: z.string(),
    old_string: toolText,
    new_string: toolText,
    replace_all: z.unknown().optional(),
  }),
  [deleteFileTool]: z.strictObject({ file_path: z.string() }),
};
/**
 * What every editing decision is judged against: the worktree, the approved policy and the snapshot
 * captured before the turn. Paths are authorised only if they match this snapshot or an explicit creation.
 */
export interface EditingContext {
  cwd: string;
  policy: EditPolicy;
  snapshot: RepositorySnapshot;
}
/** Throws a scope message when a file is larger than one editable file may be (`editLimits.fileBytes`). */
export function checkEditableSize(path: string, bytes: number): void {
  if (bytes > editLimits.fileBytes)
    throw new Error(
      `Editable text file "${path}" is ${bytes} bytes; the limit is ${formatBytes(editLimits.fileBytes)} (${editLimits.fileBytes} bytes). Revise the task scope or split the file before retrying.`,
    );
}
// Comparison key for paths: Windows file systems are case-insensitive, so differently cased paths are one file.
const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
// Repository control components (Git, agent configuration and instruction files) are never editable.
const protectedPath = (path: string) =>
  path.split(/[\\/]/).some(part => /^(\.git|\.claude|\.codex|\.grampus|AGENTS\.md|CLAUDE\.md)$/i.test(part));

/** One permission predicate is shared by native tools, patches and final artifact verification. */
function policyAllows(context: EditingContext, action: 'edit' | 'create' | 'delete', path: string): boolean {
  const paths = action === 'edit' ? context.policy.files : context.policy[action];
  return !!paths?.some(value => key(value) === key(path)) || directoryAllows(context.policy.directories, action, path);
}

function creationAllowed(context: EditingContext, path: string): boolean {
  return (
    policyAllows(context, 'create', path) &&
    !context.snapshot.files.some(file => key(file.path) === key(path) && file.sha256 !== null)
  );
}

/**
 * The digests and path lists of a candidate policy. Paths are left unknown here so that a non-string
 * path is reported with the path rule below rather than as a malformed policy.
 */
const editPolicyShape = z.strictObject({
  artifact: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  instructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.unknown()),
  create: z.array(z.unknown()).optional(),
  delete: z.array(z.unknown()).optional(),
  directories: z.array(directoryScopeSchema).min(1).max(editLimits.directories).optional(),
});

/**
 * Validates an edit policy from any source (plan, CLI file or journal) before it authorises edits:
 * current-format digests and 1 to `editLimits.paths` distinct editable paths across files, creations
 * and deletions. Distinctness is case-insensitive on Windows, where such paths are the same file.
 * Throws on the first problem.
 */
export function validateEditPolicy(policy: unknown): asserts policy is EditPolicy {
  const shape = editPolicyShape.safeParse(policy);
  if (!shape.success) throw new Error('Invalid edit policy');
  const paths = [...shape.data.files, ...(shape.data.create ?? []), ...(shape.data.delete ?? [])];
  const editable = paths.filter(editablePath);
  if (
    (!paths.length && !shape.data.directories?.length) ||
    paths.length > editLimits.paths ||
    editable.length !== paths.length ||
    new Set(editable.map(key)).size !== editable.length
  )
    throw new Error(
      `Edit policy requires current digests and 1–${editLimits.paths} distinct relative file paths; repository controls cannot be edited`,
    );
}

/**
 * Throws unless `part` (the tool path relative to the worktree root) stays inside the worktree, has
 * no drive or stream separator, no segment Windows would silently alter, and no repository control
 * component.
 */
function requireEditableLocation(part: string): void {
  if (
    !part ||
    isAbsolute(part) ||
    part === '..' ||
    part.startsWith(`..${sep}`) ||
    part.includes(':') ||
    part.split(/[\\/]/).some(value => /[. ]$/.test(value)) ||
    protectedPath(part)
  )
    throw new Error('Tool path is outside editable repository content');
}

/** One component on the way from a tool's target file up to the worktree root. */
interface PathComponent {
  root: string;
  inputPath: string;
  current: string;
  /** The tool's target itself rather than one of its parent directories. */
  target: boolean;
}

/**
 * The component's `lstat`, or null when the target is allowed to be missing (an authorised creation
 * or an already deleted file). Any other missing component is a scope error naming it.
 */
function componentStat({ root, inputPath, current, target }: PathComponent, mayBeMissing: boolean): Stats | null {
  try {
    return lstatSync(current);
  } catch (error) {
    if (systemErrorCode(error) !== 'ENOENT') throw error;
    if (mayBeMissing) return null;
    throw new Error(
      `File scope "${inputPath}" requires ${target ? 'an existing file' : `existing parent directories (missing "${relative(root, current)}")`}. Revise the task scope before retrying.`,
      { cause: error },
    );
  }
}

/**
 * Throws unless the component is what a tool may write through: the target a regular, singly linked
 * file within the size limit, every parent a real directory, and no symbolic link, hard link or other
 * alias whose real path differs, so a tool can only ever reach the path it names.
 */
function requirePlainComponent(component: PathComponent, stat: Stats): void {
  const { root, inputPath, current, target } = component;
  if (stat.isSymbolicLink() || (target && stat.isFile() && stat.nlink !== 1))
    throw new Error(
      `Tools require files without links: "${inputPath}" resolves through a link at "${relative(root, current)}". Revise the task scope before retrying.`,
    );
  if (target && !stat.isFile())
    throw new Error(
      `Tools require regular text files: "${inputPath}" is not a regular file. Revise the task scope before retrying.`,
    );
  if (!target && !stat.isDirectory())
    throw new Error(
      `Tools require existing parent directories: "${inputPath}" has a non-directory parent "${relative(root, current)}". Revise the task scope before retrying.`,
    );
  if (target) checkEditableSize(inputPath, stat.size);
  if (key(realpathSync.native(current)) !== key(current))
    throw new Error(`Tool path "${inputPath}" resolves through an alias at "${relative(root, current)}"`);
}

/**
 * Resolves a tool path to an existing snapshot file or an authorised creation and returns its
 * snapshot path with its current bytes (null when the file is absent, which `allowMissing` permits
 * only for a creation or deletion). The bytes must be UTF-8 text. Throws a scope message otherwise.
 */
function checkedFile(
  context: EditingContext,
  inputPath: string,
  allowMissing = false,
): { path: string; bytes: Buffer | null } {
  if (inputPath.includes('\0')) throw new Error('Invalid tool path');
  const root = realpathSync.native(context.cwd);
  const absolute = resolve(root, inputPath);
  requireEditableLocation(relative(root, absolute));
  const file = context.snapshot.files.find(
    file => file.sha256 !== null && key(resolve(root, file.path)) === key(absolute),
  );
  const relativePath = relative(root, absolute).split(sep).join('/');
  const creation = creationAllowed(context, relativePath) ? relativePath : undefined;
  const deletion = file && policyAllows(context, 'delete', file.path);
  const target = file?.path ?? creation;
  if (target === undefined) throw new Error('Tool path is not an existing snapshot file or explicit creation path');
  let present = true;
  // Walk from the target up to the root so no link or alias anywhere on the way can redirect the write.
  for (let current = absolute; key(current) !== key(root); current = dirname(current)) {
    const component = { root, inputPath, current, target: current === absolute };
    const mayBeMissing = component.target
      ? !!(creation || deletion)
      : !!creation && directoryAllows(context.policy.directories, 'create', relativePath);
    const stat = componentStat(component, mayBeMissing && allowMissing);
    if (!stat) {
      present = false;
      continue;
    }
    requirePlainComponent(component, stat);
  }
  if (!present) return { path: target, bytes: null };
  const bytes = readFileSync(absolute);
  checkEditableSize(inputPath, bytes.length);
  // Invalid UTF-8 does not survive a decode and re-encode unchanged.
  if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))
    throw new Error(
      `Tools require UTF-8 text files: "${inputPath}" contains binary or invalid UTF-8 content. Revise the task scope before retrying.`,
    );
  return { path: target, bytes };
}

/**
 * Throws unless `file` is an approved deletion whose current bytes still equal the snapshot, so a file
 * edited after the snapshot is never removed.
 */
function requireDeletion(context: EditingContext, file: { path: string; bytes: Buffer | null }): void {
  const original = context.snapshot.files.find(before => key(before.path) === key(file.path));
  if (
    !policyAllows(context, 'delete', file.path) ||
    !file.bytes ||
    !original?.sha256 ||
    createHash('sha256').update(file.bytes).digest('hex') !== original.sha256
  )
    throw new Error('Deletion requires an explicit existing path with unchanged snapshot bytes');
}

/**
 * Checks before an editing turn (or a preparation check) starts that the policy is valid and still bound
 * to the snapshot's artifact and instructions, every edited or deleted file is present and editable, the
 * total scope is within `editLimits.scopeBytes`, and every creation is absent and would not be ignored.
 *
 * @throws Error naming the first problem; nothing is modified.
 */
export function prepareEditing(context: EditingContext): void {
  validateEditPolicy(context.policy);
  if (
    context.snapshot.artifact !== context.policy.artifact ||
    context.snapshot.instructionsDigest !== context.policy.instructionsDigest
  )
    throw new Error('Edit policy no longer matches repository content or instructions');
  let bytes = 0;
  for (const path of [...context.policy.files, ...(context.policy.delete ?? [])]) {
    const file = checkedFile(context, path);
    if (file.bytes === null) throw new Error(`Editable file "${path}" is missing from the workspace`);
    bytes += file.bytes.length;
    if (context.policy.delete?.includes(path)) requireDeletion(context, file);
  }
  if (bytes > editLimits.scopeBytes)
    throw new Error(
      `Editable text exceeds the ${formatBytes(editLimits.scopeBytes)} scope limit. Revise the task into smaller slices before retrying.`,
    );
  for (const path of context.policy.create ?? []) {
    if (
      context.snapshot.files.some(file => key(file.path) === key(path)) ||
      checkedFile(context, path, true).bytes !== null
    )
      throw new Error('Creation path must be absent from the snapshot and filesystem');
    requireSnapshotVisible(context.cwd, path);
  }
}

/**
 * Inline editable text within the turn's prompt budget. With exploration, a file over
 * `editLimits.inlineFileBytes` or beyond the budget is deferred to paginated reads of current bytes; the
 * smaller form of every entry is charged first, so deferring always fits once that charge succeeds.
 * Returns a JSON array for the prompt; absent creations have null content. The `readWith` text is part
 * of the provider contract.
 *
 * @throws PromptBudgetError when the entries cannot fit the budget (every content, without exploration);
 *   Error when a file breaks the scope rules.
 */
export function editingFileContext(context: EditingContext, exploration = false, budget = new PromptBudget()): string {
  const entries = [...context.policy.files, ...(context.policy.create ?? []), ...(context.policy.delete ?? [])].map(
    path => {
      const file = checkedFile(context, path, true);
      const item = { path: file.path, content: file.bytes?.toString('utf8') ?? null };
      const deferred =
        exploration && file.bytes
          ? {
              path: file.path,
              content: null,
              deferred: true,
              bytes: file.bytes.length,
              sha256: createHash('sha256').update(file.bytes).digest('hex'),
              readWith:
                'grampus_read_file with mode=characters; follow nextOffset to read current contents before editing',
            }
          : null;
      return { file, item, itemBytes: promptBytes(JSON.stringify(item)), deferred };
    },
  );
  // Brackets, one separator per entry and each entry's smallest form.
  budget.require(
    entries.reduce(
      (sum, entry) => sum + (entry.deferred ? promptBytes(JSON.stringify(entry.deferred)) : entry.itemBytes) + 1,
      2,
    ),
    'Editable file context',
    exploration
      ? 'reduce the slice file scope'
      : 'enable repository exploration or revise the task into smaller slices',
  );
  return JSON.stringify(
    entries.map(({ file, item, itemBytes, deferred }) => {
      if (!deferred) return item;
      const extra = Math.max(itemBytes - promptBytes(JSON.stringify(deferred)), 0);
      return (file.bytes?.length ?? 0) <= editLimits.inlineFileBytes && budget.offer(extra) ? item : deferred;
    }),
  );
}

/**
 * Authorization shows complete approved text, independently of the smaller model prompt budget. Every
 * file must still match its snapshot hash, so what is shown for approval is exactly what the snapshot records.
 *
 * @throws Error when preparation fails or a file changed since the snapshot.
 */
export function editingScopeFiles(context: EditingContext): { path: string; content: string | null }[] {
  prepareEditing(context);
  return [...context.policy.files, ...(context.policy.create ?? []), ...(context.policy.delete ?? [])].map(path => {
    const file = checkedFile(context, path, true);
    if (
      file.bytes &&
      createHash('sha256').update(file.bytes).digest('hex') !==
        context.snapshot.files.find(value => key(value.path) === key(file.path))?.sha256
    )
      throw new Error(`Repository changed while preparing file authorization: "${file.path}"`);
    return { path: file.path, content: file.bytes?.toString('utf8') ?? null };
  });
}

/**
 * Authorize the entire proposed native patch, never a subset or future patches. Used for Codex
 * `fileChange` approvals: every change must be an approved update, creation or deletion, each path at
 * most once. The decision is journaled through `emit` before returning. Never throws: any failure,
 * including a journal failure for the denial, returns false.
 */
export function authorizeFileChanges(
  context: EditingContext,
  changes: unknown,
  emit: (event: AgentEvent) => void,
): boolean {
  const paths: string[] = [];
  try {
    if (!Array.isArray(changes) || !changes.length || changes.length > editLimits.paths)
      throw new Error(`Patch requires 1–${editLimits.paths} explicitly scoped file changes`);
    const parsed = z.array(codexFileChangeSchema).safeParse(changes);
    if (!parsed.success)
      throw new Error('Only bounded text updates, explicit additions and explicit deletions without moves are allowed');
    for (const change of parsed.data) {
      const file = checkedFile(context, change.path, change.kind.type === 'add');
      const creation = creationAllowed(context, file.path);
      if (change.kind.type === 'delete') requireDeletion(context, file);
      if (
        (change.kind.type === 'add' && (!creation || file.bytes !== null)) ||
        (change.kind.type === 'update' && !creation && !policyAllows(context, 'edit', file.path)) ||
        paths.some(path => key(path) === key(file.path))
      )
        throw new Error('Patch file is unapproved, already exists or repeated');
      if (creation) requireSnapshotVisible(context.cwd, file.path);
      paths.push(file.path);
    }
    emit({ type: 'tool.authorized', data: { tool: 'apply_patch', paths } });
    return true;
  } catch (error) {
    try {
      emit({
        type: 'tool.denied',
        data: { tool: 'apply_patch', paths, reason: error instanceof Error ? error.message : String(error) },
      });
    } catch {
      /* Fail closed when the journal is unavailable. */
    }
    return false;
  }
}

/** Throws unless the tool's other options match its strict schema (bounded text, known options only). */
function requireToolOptions(name: string, input: unknown): void {
  const options = fileToolSchemas[name]?.safeParse(input);
  if (!options?.success)
    throw new Error(
      options?.error.issues.some(issue => issue.code === 'unrecognized_keys')
        ? 'Unsupported file tool option'
        : 'File tool text exceeds the allowed format or size',
    );
}

/**
 * Decides one native file tool call against the policy and returns the authorised snapshot path. The
 * path is checked before the options so a denial names the most relevant reason.
 */
function authorizeFileTool(context: EditingContext, name: string, input: unknown, decided: (path: string) => void) {
  if (!['Read', 'Edit', 'Write', deleteFileTool].includes(name))
    throw new Error('Only Read, Edit, Write and the scoped deletion tool are enabled');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool input');
  const target = filePathSchema.safeParse(input);
  if (!target.success) throw new Error('Tool requires file_path');
  const file = checkedFile(context, target.data.file_path, name === 'Write');
  const filePath = file.path;
  decided(filePath);
  const creation = creationAllowed(context, filePath);
  if (name === deleteFileTool) requireDeletion(context, file);
  else if (name !== 'Read' && !creation && !policyAllows(context, 'edit', filePath))
    throw new Error('File is not authorized for editing');
  if (creation) requireSnapshotVisible(context.cwd, filePath);
  requireToolOptions(name, input);
  return filePath;
}

/**
 * Decides one Claude tool call and journals the decision before the SDK may perform any file I/O, so
 * every allowed action is on record first. Never throws: a journal failure denies the tool.
 */
export function authorizeEditTool(
  context: EditingContext,
  name: string,
  input: unknown,
  emit: (event: AgentEvent) => void,
): { allowed: boolean; reason: string } {
  let path: string | null = null;
  try {
    if (name === 'StructuredOutput') {
      if (Buffer.byteLength(JSON.stringify(input) ?? '') > editLimits.structuredReplyBytes)
        throw new Error('Structured reply exceeds the current size limit');
      parseReply(input);
      emit({ type: 'tool.authorized', data: { tool: name, path: null } });
      return { allowed: true, reason: 'Validated structured final reply; no repository action' };
    }
    path = authorizeFileTool(context, name, input, decided => (path = decided));
    emit({ type: 'tool.authorized', data: { tool: name, path } });
    return { allowed: true, reason: 'Within the explicit file policy' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      emit({ type: 'tool.denied', data: { tool: name, path, reason } });
    } catch {
      /* A journal failure must never allow a tool. */
    }
    return { allowed: false, reason };
  }
}

/**
 * Runs inside the supervised worker; hooks alone cannot authorize the actual unlink. The decision is
 * journaled first, then the bytes are rechecked against the snapshot immediately before unlinking.
 *
 * @throws Error when the deletion is refused or the file no longer matches its snapshot.
 */
export function deleteEditingFile(context: EditingContext, input: unknown, emit: (event: AgentEvent) => void): void {
  const decision = authorizeEditTool(context, deleteFileTool, input, emit);
  if (!decision.allowed) throw new Error(decision.reason);
  const file = checkedFile(context, filePathSchema.parse(input).file_path);
  requireDeletion(context, file);
  unlinkSync(resolve(realpathSync.native(context.cwd), file.path));
  emit({ type: 'tool.deleted', data: { tool: deleteFileTool, path: file.path } });
}

/**
 * Editing may change file contents only. Staging is reported on its own because the person can
 * finish it and retry, whereas a moved HEAD or changed instructions invalidate the attempt.
 */
function requireUnchangedGitState(context: EditingContext, after: RepositorySnapshot): void {
  if (
    after.head === context.snapshot.head &&
    after.instructionsDigest === context.snapshot.instructionsDigest &&
    after.index !== context.snapshot.index
  ) {
    throw new Error(
      'Files were staged or unstaged during this attempt. Edits are preserved. Finish staging, then choose Retry repair.',
    );
  }
  if (
    after.head !== context.snapshot.head ||
    after.index !== context.snapshot.index ||
    after.instructionsDigest !== context.snapshot.instructionsDigest
  )
    throw new Error('Editing changed Git state or repository instructions');
}

/**
 * Throws unless the files the edit policy names are still exactly as the final snapshot records them:
 * edited files readable within the rules, deletions really gone (or still unchanged), and creations
 * present in the snapshot and not ignored.
 */
function requirePolicyFilesSettled(context: EditingContext, after: RepositorySnapshot): void {
  for (const path of context.policy.files) checkedFile(context, path);
  for (const path of context.policy.delete ?? []) {
    const file = checkedFile(context, path, true);
    const current = after.files.find(value => key(value.path) === key(file.path));
    if ((file.bytes === null) !== (!current || current.sha256 === null))
      throw new Error('Deletion no longer matches the final snapshot');
    if (file.bytes !== null) requireDeletion(context, file);
  }
  for (const path of context.policy.create ?? []) {
    const file = checkedFile(context, path, true);
    if (file.bytes !== null && !after.files.some(current => key(current.path) === key(path) && current.sha256 !== null))
      throw new Error('Created file is missing from repository snapshot');
    requireSnapshotVisible(context.cwd, path);
  }
}

/**
 * Verifies a finished editing turn against its policy from the before and after snapshots: no Git or
 * instruction change, content changes only in authorised files, membership changes only by authorised
 * creations and deletions, and no executable bit changes. Throws a message naming the violation.
 */
export function verifyEditingScope(
  context: EditingContext,
  after: RepositorySnapshot,
  nativeCreations: readonly string[] = [],
): void {
  requireUnchangedGitState(context, after);
  const beforeFiles = new Map(context.snapshot.files.map(file => [file.path, file]));
  const afterFiles = new Map(after.files.map(file => [file.path, file]));
  for (const before of context.snapshot.files) {
    const current = afterFiles.get(before.path);
    // An approved deletion that is gone is the one membership change allowed for an existing file.
    if (before.sha256 !== null && (!current || current.sha256 === null) && policyAllows(context, 'delete', before.path))
      continue;
    if (
      !current ||
      (current.sha256 === null && before.sha256 !== null) ||
      current.executable !== before.executable ||
      (current.sha256 !== before.sha256 && !policyAllows(context, 'edit', before.path))
    )
      throw new Error('Editing changed content outside the explicit file policy');
  }
  for (const file of after.files) {
    if (beforeFiles.has(file.path)) continue;
    if (file.sha256 === null || file.executable || !policyAllows(context, 'create', file.path))
      throw new Error('Editing changed file membership outside the explicit creation policy');
  }
  requirePolicyFilesSettled(context, after);
  requireNativeCreationsSettled(context, after, nativeCreations);
  requireChangedBounds(context, after);
}

function requireNativeCreationsSettled(
  context: EditingContext,
  after: RepositorySnapshot,
  nativeCreations: readonly string[],
): void {
  for (const path of nativeCreations) {
    const file = checkedFile(context, path, true);
    if (file.bytes === null) continue;
    requireSnapshotVisible(context.cwd, file.path);
    if (!after.files.some(current => key(current.path) === key(file.path) && current.sha256 !== null))
      throw new Error('Native creation is missing from the final snapshot');
  }
}

function requireChangedBounds(context: EditingContext, after: RepositorySnapshot): void {
  const beforeFiles = new Map(context.snapshot.files.map(file => [file.path, file]));
  const afterFiles = new Map(after.files.map(file => [file.path, file]));
  const changed = after.files.filter(
    file => file.sha256 !== null && file.sha256 !== beforeFiles.get(file.path)?.sha256,
  );
  const deleted = context.snapshot.files.filter(file => file.sha256 !== null && !afterFiles.get(file.path)?.sha256);
  if (changed.length + deleted.length > editLimits.paths)
    throw new Error('Directory scope exceeds the changed path limit');
  let bytes = 0;
  for (const file of changed) {
    const current = checkedFile(context, file.path);
    bytes += current.bytes?.length ?? 0;
  }
  if (bytes > editLimits.scopeBytes) throw new Error('Directory scope exceeds the changed text limit');
}

/**
 * System instructions for an implementation turn, with the provider's own tool policy sentence. The text
 * is a provider contract: change it deliberately.
 */
export function implementationInstructions(toolPolicy: string): string {
  return `You are implementing an approved Grampus task. ${toolPolicy} Only explicitly authorized files may be edited. Use configured MCP integrations to gather task context. Use grampus_run_check when offered to request approved controller-run formatting and checks against your current edits. Diagnose failures and repair them before finishing. Do not execute shell commands, delegate, change repository instructions, or claim acceptance or completion. Report check results only from retained controller evidence. External actions require explicit task authorization. Follow the supplied repository instructions within this tool policy. Return the supplied JSON response format: kind=message with a concise change summary, or kind=question with stable question ids and choices if consequential information is missing. Include text, questions and findings; unused arrays are empty.`;
}
/** Implementation instructions for Claude's native file tools and the scoped deletion tool. */
export const editingInstructions = implementationInstructions(
  `Use only Read, Edit and Write on the supplied repository files. When exact deletion paths are supplied, use ${deleteFileTool} to remove them without running commands. Deletion paths cannot be edited, overwritten or recreated; directory deletion is forbidden.`,
);
