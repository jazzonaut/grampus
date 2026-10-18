import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositorySnapshot } from './artifacts.js';
import { parseReply, type AgentEvent } from './agents/types.js';

export interface EditPolicy {
  artifact: string;
  instructionsDigest: string;
  files: string[];
  create?: string[];
  delete?: string[];
}
export interface EditingContext {
  cwd: string;
  policy: EditPolicy;
  snapshot: RepositorySnapshot;
}
export const editLimits = {
  fileBytes: 1024 * 1024,
  scopeBytes: 4 * 1024 * 1024,
  inlineBytes: 768 * 1024,
  inlineFileBytes: 256 * 1024,
};
export function checkEditableSize(path: string, bytes: number): void {
  if (bytes > editLimits.fileBytes)
    throw new Error(
      `Editable text file "${path}" is ${bytes} bytes; the limit is 1 MiB (${editLimits.fileBytes} bytes). Revise the task scope or split the file before retrying.`,
    );
}
export const deleteFileTool = 'mcp__grampus_files__delete_file';
const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const protectedPath = (path: string) =>
  path.split(/[\\/]/).some(part => /^(\.git|\.claude|\.codex|\.grampus|AGENTS\.md|CLAUDE\.md)$/i.test(part));

export function validateEditPolicy(policy: EditPolicy): void {
  if (
    !policy ||
    Object.keys(policy).some(
      field => !['artifact', 'instructionsDigest', 'files', 'create', 'delete'].includes(field),
    ) ||
    typeof policy.artifact !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(policy.artifact) ||
    typeof policy.instructionsDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(policy.instructionsDigest) ||
    !Array.isArray(policy.files) ||
    (policy.create !== undefined && !Array.isArray(policy.create)) ||
    (policy.delete !== undefined && !Array.isArray(policy.delete))
  )
    throw new Error('Invalid edit policy');
  const paths = [...policy.files, ...(policy.create ?? []), ...(policy.delete ?? [])];
  if (
    paths.length < 1 ||
    paths.length > 64 ||
    paths.some(
      path =>
        typeof path !== 'string' ||
        !path ||
        path.length > 512 ||
        isAbsolute(path) ||
        /[\\:<>"|?*\x00-\x1f]/.test(path) ||
        path
          .split('/')
          .some(
            part =>
              !part ||
              part === '.' ||
              part === '..' ||
              /[. ]$/.test(part) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
          ) ||
        protectedPath(path),
    ) ||
    new Set(paths.map(key)).size !== paths.length
  )
    throw new Error(
      'Edit policy requires current digests and 1–64 distinct relative file paths; repository controls cannot be edited',
    );
}

function checkedFile(
  context: EditingContext,
  inputPath: string,
  allowMissing = false,
): { path: string; bytes: Buffer | null } {
  if (inputPath.includes('\0')) throw new Error('Invalid tool path');
  const root = realpathSync.native(context.cwd);
  const absolute = resolve(root, inputPath);
  const part = relative(root, absolute);
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
  const file = context.snapshot.files.find(
    file => file.sha256 !== null && key(resolve(root, file.path)) === key(absolute),
  );
  const creation = context.policy.create?.find(path => key(resolve(root, path)) === key(absolute));
  const deletion = file && context.policy.delete?.some(path => key(path) === key(file.path));
  if (!file && !creation) throw new Error('Tool path is not an existing snapshot file or explicit creation path');
  let present = true;
  for (let current = absolute; key(current) !== key(root); current = dirname(current)) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (
        current === absolute &&
        (creation || deletion) &&
        allowMissing &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        present = false;
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `File scope "${inputPath}" requires ${current === absolute ? 'an existing file' : `existing parent directories (missing "${relative(root, current)}")`}. Revise the task scope before retrying.`,
        );
      throw error;
    }
    if (stat.isSymbolicLink() || (current === absolute && stat.isFile() && stat.nlink !== 1))
      throw new Error(
        `Tools require files without links: "${inputPath}" resolves through a link at "${relative(root, current)}". Revise the task scope before retrying.`,
      );
    if (current === absolute && !stat.isFile())
      throw new Error(
        `Tools require regular text files: "${inputPath}" is not a regular file. Revise the task scope before retrying.`,
      );
    if (current !== absolute && !stat.isDirectory())
      throw new Error(
        `Tools require existing parent directories: "${inputPath}" has a non-directory parent "${relative(root, current)}". Revise the task scope before retrying.`,
      );
    if (current === absolute) checkEditableSize(inputPath, stat.size);
    if (key(realpathSync.native(current)) !== key(current))
      throw new Error(`Tool path "${inputPath}" resolves through an alias at "${relative(root, current)}"`);
  }
  if (!present) return { path: file?.path ?? creation!, bytes: null };
  const bytes = readFileSync(absolute);
  checkEditableSize(inputPath, bytes.length);
  if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))
    throw new Error(
      `Tools require UTF-8 text files: "${inputPath}" contains binary or invalid UTF-8 content. Revise the task scope before retrying.`,
    );
  return { path: file?.path ?? creation!, bytes };
}

function requireDeletion(context: EditingContext, file: { path: string; bytes: Buffer | null }): void {
  const original = context.snapshot.files.find(before => key(before.path) === key(file.path));
  if (
    !context.policy.delete?.some(path => key(path) === key(file.path)) ||
    !file.bytes ||
    !original?.sha256 ||
    createHash('sha256').update(file.bytes).digest('hex') !== original.sha256
  )
    throw new Error('Deletion requires an explicit existing path with unchanged snapshot bytes');
}

function requireVisibleCreation(context: EditingContext, path: string): void {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const result = spawnSync(
    'git',
    ['--no-optional-locks', '-C', context.cwd, 'check-ignore', '--no-index', '-q', '--', path],
    { env, windowsHide: true, timeout: 30_000, stdio: 'pipe' },
  );
  if (result.error || result.status !== 1)
    throw new Error('Creation paths must be visible to repository snapshots, not ignored');
}

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
    bytes += file.bytes!.length;
    if (context.policy.delete?.includes(path)) requireDeletion(context, file);
  }
  if (bytes > editLimits.scopeBytes)
    throw new Error(
      'Editable text exceeds the 4 MiB scope limit. Revise the task into smaller slices before retrying.',
    );
  for (const path of context.policy.create ?? []) {
    if (
      context.snapshot.files.some(file => key(file.path) === key(path)) ||
      checkedFile(context, path, true).bytes !== null
    )
      throw new Error('Creation path must be absent from the snapshot and filesystem');
    requireVisibleCreation(context, path);
  }
}

/** Keep editable text inline for legacy sessions; exploration can retrieve deferred current bytes. */
export function editingFileContext(context: EditingContext, exploration = false): string {
  let size = 2;
  const content = JSON.stringify(
    [...context.policy.files, ...(context.policy.create ?? []), ...(context.policy.delete ?? [])].map(path => {
      const file = checkedFile(context, path, true);
      const item = { path: file.path, content: file.bytes?.toString('utf8') ?? null };
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (
        exploration &&
        file.bytes &&
        (file.bytes.length > editLimits.inlineFileBytes || size + bytes > editLimits.inlineBytes - 64 * 1024)
      ) {
        const deferred = {
          path: file.path,
          content: null,
          deferred: true,
          bytes: file.bytes.length,
          sha256: createHash('sha256').update(file.bytes).digest('hex'),
          readWith: 'grampus_read_file with mode=characters; follow nextOffset to read current contents before editing',
        };
        size += Buffer.byteLength(JSON.stringify(deferred)) + 1;
        return deferred;
      }
      size += bytes;
      return item;
    }),
  );
  if (Buffer.byteLength(content) > editLimits.inlineBytes)
    throw new Error(
      'Editable file context exceeds 768 KiB; enable repository exploration or revise the task into smaller slices',
    );
  return content;
}

/** Authorization shows complete approved text, independently of the smaller model prompt budget. */
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

/** Authorize the entire proposed native patch, never a subset or future patches. */
export function authorizeFileChanges(
  context: EditingContext,
  changes: unknown,
  emit: (event: AgentEvent) => void,
): boolean {
  const paths: string[] = [];
  try {
    if (!Array.isArray(changes) || !changes.length || changes.length > 64)
      throw new Error('Patch requires 1–64 explicitly scoped file changes');
    for (const change of changes) {
      if (
        !change ||
        typeof change !== 'object' ||
        Object.keys(change).some(field => !['path', 'kind', 'diff'].includes(field)) ||
        typeof change.path !== 'string' ||
        !change.kind ||
        !['update', 'add', 'delete'].includes(change.kind.type) ||
        change.kind.move_path != null ||
        Object.keys(change.kind).some(
          field => !(change.kind.type === 'update' ? ['type', 'move_path'] : ['type']).includes(field),
        ) ||
        typeof change.diff !== 'string' ||
        change.diff.includes('\0') ||
        Buffer.byteLength(change.diff) > 256 * 1024
      )
        throw new Error(
          'Only bounded text updates, explicit additions and explicit deletions without moves are allowed',
        );
      const file = checkedFile(context, change.path, change.kind.type === 'add');
      const creation = context.policy.create?.some(path => key(path) === key(file.path));
      if (change.kind.type === 'delete') requireDeletion(context, file);
      if (
        (change.kind.type === 'add' && (!creation || file.bytes !== null)) ||
        (change.kind.type === 'update' &&
          !creation &&
          !context.policy.files.some(path => key(path) === key(file.path))) ||
        paths.some(path => key(path) === key(file.path))
      )
        throw new Error('Patch file is unapproved, already exists or repeated');
      if (creation) requireVisibleCreation(context, file.path);
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

/** Persist each decision before allowing the SDK to perform file I/O. */
export function authorizeEditTool(
  context: EditingContext,
  name: string,
  input: unknown,
  emit: (event: AgentEvent) => void,
): { allowed: boolean; reason: string } {
  let path: string | null = null;
  try {
    if (name === 'StructuredOutput') {
      if (Buffer.byteLength(JSON.stringify(input) ?? '') > 64 * 1024)
        throw new Error('Structured reply exceeds the current size limit');
      parseReply(input);
      emit({ type: 'tool.authorized', data: { tool: name, path: null } });
      return { allowed: true, reason: 'Validated structured final reply; no repository action' };
    }
    if (!['Read', 'Edit', 'Write', deleteFileTool].includes(name))
      throw new Error('Only Read, Edit, Write and the scoped deletion tool are enabled');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool input');
    const fields = input as Record<string, unknown>;
    if (typeof fields.file_path !== 'string') throw new Error('Tool requires file_path');
    const file = checkedFile(context, fields.file_path, name === 'Write');
    path = file.path;
    const creation = context.policy.create?.some(value => key(value) === key(path!));
    if (name === deleteFileTool) requireDeletion(context, file);
    else if (name !== 'Read' && !creation && !context.policy.files.some(value => key(value) === key(path!)))
      throw new Error('File is not authorized for editing');
    if (creation) requireVisibleCreation(context, path);
    const allowedKeys =
      name === deleteFileTool
        ? ['file_path']
        : name === 'Read'
          ? ['file_path', 'offset', 'limit']
          : name === 'Write'
            ? ['file_path', 'content']
            : ['file_path', 'old_string', 'new_string', 'replace_all'];
    if (Object.keys(fields).some(value => !allowedKeys.includes(value)))
      throw new Error('Unsupported file tool option');
    const textFields =
      name === 'Read' || name === deleteFileTool ? [] : name === 'Write' ? ['content'] : ['old_string', 'new_string'];
    if (
      textFields.some(
        field =>
          typeof fields[field] !== 'string' ||
          fields[field].includes('\0') ||
          Buffer.byteLength(fields[field]) > 256 * 1024,
      )
    )
      throw new Error('File tool text exceeds the allowed format or size');
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

/** Runs inside the supervised worker; hooks alone cannot authorize the actual unlink. */
export function deleteEditingFile(context: EditingContext, input: unknown, emit: (event: AgentEvent) => void): void {
  const decision = authorizeEditTool(context, deleteFileTool, input, emit);
  if (!decision.allowed) throw new Error(decision.reason);
  const file = checkedFile(context, (input as { file_path: string }).file_path);
  requireDeletion(context, file);
  unlinkSync(resolve(realpathSync.native(context.cwd), file.path));
  emit({ type: 'tool.deleted', data: { tool: deleteFileTool, path: file.path } });
}

export function verifyEditingScope(context: EditingContext, after: RepositorySnapshot): void {
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
  const beforeFiles = new Map(context.snapshot.files.map(file => [file.path, file]));
  const afterFiles = new Map(after.files.map(file => [file.path, file]));
  for (const before of context.snapshot.files) {
    const current = afterFiles.get(before.path);
    if (
      before.sha256 !== null &&
      (!current || current.sha256 === null) &&
      context.policy.delete?.some(path => key(path) === key(before.path))
    )
      continue;
    if (
      !current ||
      (current.sha256 === null && before.sha256 !== null) ||
      current.executable !== before.executable ||
      (current.sha256 !== before.sha256 && !context.policy.files.some(path => key(path) === key(before.path)))
    )
      throw new Error('Editing changed content outside the explicit file policy');
  }
  for (const file of after.files) {
    if (beforeFiles.has(file.path)) continue;
    if (file.sha256 === null || file.executable || !context.policy.create?.includes(file.path))
      throw new Error('Editing changed file membership outside the explicit creation policy');
  }
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
    if (file.bytes !== null && !after.files.some(current => current.path === path && current.sha256 !== null))
      throw new Error('Created file is missing from repository snapshot');
    requireVisibleCreation(context, path);
  }
}

export function implementationInstructions(toolPolicy: string): string {
  return `You are implementing an approved Grampus task. ${toolPolicy} Only explicitly authorized files may be edited. Use configured MCP integrations to gather task context. Do not run commands, delegate, change repository instructions, or claim tests, acceptance or completion. External actions require explicit task authorization. Follow the supplied repository instructions within this tool policy. Return the supplied JSON response format: kind=message with a concise change summary, or kind=question with stable question ids and choices if consequential information is missing. Include text, questions and findings; unused arrays are empty.`;
}
export const editingInstructions = implementationInstructions(
  `Use only Read, Edit and Write on the supplied repository files. When exact deletion paths are supplied, use ${deleteFileTool} to remove them without running commands. Deletion paths cannot be edited, overwritten or recreated; directory deletion is forbidden.`,
);
