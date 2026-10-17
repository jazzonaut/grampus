import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositorySnapshot } from './artifacts.js';
import { parseReply, type AgentEvent } from './agents/types.js';

export interface EditPolicy { artifact: string; instructionsDigest: string; files: string[] }
export interface EditingContext { cwd: string; policy: EditPolicy; snapshot: RepositorySnapshot }
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const protectedPath = (path: string) => path.split(/[\\/]/).some(part => /^(\.git|\.claude|\.codex|\.grampus|AGENTS\.md|CLAUDE\.md)$/i.test(part));

export function validateEditPolicy(policy: EditPolicy): void {
  if (!policy || Object.keys(policy).some(field => !['artifact', 'instructionsDigest', 'files'].includes(field))
    || typeof policy.artifact !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(policy.artifact)
    || typeof policy.instructionsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.instructionsDigest)
    || !Array.isArray(policy.files) || policy.files.length < 1 || policy.files.length > 64
    || policy.files.some(path => typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path)
      || /[\\:\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) || protectedPath(path))
    || new Set(policy.files.map(key)).size !== policy.files.length) throw new Error('Edit policy requires current digests and 1–64 distinct relative file paths; repository controls cannot be edited');
}

function checkedFile(context: EditingContext, inputPath: string): { path: string; bytes: Buffer } {
  if (inputPath.includes('\0')) throw new Error('Invalid tool path');
  const root = realpathSync.native(context.cwd); const absolute = resolve(root, inputPath); const part = relative(root, absolute);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`) || part.includes(':')
    || part.split(/[\\/]/).some(value => /[. ]$/.test(value)) || protectedPath(part)) throw new Error('Tool path is outside editable repository content');
  const file = context.snapshot.files.find(file => file.sha256 !== null && key(resolve(root, file.path)) === key(absolute));
  if (!file) throw new Error('Tool path is not an existing snapshot file');
  for (let current = absolute; key(current) !== key(root); current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current === absolute && (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024))) throw new Error('Tools require bounded regular text files without links');
  }
  if (key(realpathSync.native(absolute)) !== key(absolute)) throw new Error('Tool path resolves through an alias');
  const bytes = readFileSync(absolute);
  if (bytes.length > 256 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('Tools require UTF-8 text files of at most 256 KiB');
  return { path: file.path, bytes };
}

export function prepareEditing(context: EditingContext): void {
  validateEditPolicy(context.policy);
  if (context.snapshot.artifact !== context.policy.artifact || context.snapshot.instructionsDigest !== context.policy.instructionsDigest) throw new Error('Edit policy no longer matches repository content or instructions');
  for (const path of context.policy.files) checkedFile(context, path);
}

/** Persist each decision before allowing the SDK to perform file I/O. */
export function authorizeEditTool(context: EditingContext, name: string, input: unknown, emit: (event: AgentEvent) => void): { allowed: boolean; reason: string } {
  let path: string | null = null;
  try {
    if (name === 'StructuredOutput') {
      if (Buffer.byteLength(JSON.stringify(input) ?? '') > 64 * 1024) throw new Error('Structured reply exceeds the current size limit');
      parseReply(input);
      emit({ type: 'tool.authorized', data: { tool: name, path: null } });
      return { allowed: true, reason: 'Validated structured final reply; no repository action' };
    }
    if (!['Read', 'Edit', 'Write'].includes(name)) throw new Error('Only Read, Edit and Write tools are enabled');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool input');
    const fields = input as Record<string, unknown>;
    if (typeof fields.file_path !== 'string') throw new Error('Tool requires file_path');
    const file = checkedFile(context, fields.file_path); path = file.path;
    if (name !== 'Read' && !context.policy.files.some(value => key(value) === key(path!))) throw new Error('File is not authorized for editing');
    const allowedKeys = name === 'Read' ? ['file_path', 'offset', 'limit'] : name === 'Write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string', 'replace_all'];
    if (Object.keys(fields).some(value => !allowedKeys.includes(value))) throw new Error('Unsupported file tool option');
    const textFields = name === 'Read' ? [] : name === 'Write' ? ['content'] : ['old_string', 'new_string'];
    if (textFields.some(field => typeof fields[field] !== 'string' || (fields[field] as string).includes('\0') || Buffer.byteLength(fields[field] as string) > 256 * 1024)) throw new Error('File tool text exceeds the allowed format or size');
    emit({ type: 'tool.authorized', data: { tool: name, path } });
    return { allowed: true, reason: 'Within the explicit file policy' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try { emit({ type: 'tool.denied', data: { tool: name, path, reason } }); } catch { /* A journal failure must never allow a tool. */ }
    return { allowed: false, reason };
  }
}

export function verifyEditingScope(context: EditingContext, after: RepositorySnapshot): void {
  if (after.head !== context.snapshot.head || after.index !== context.snapshot.index || after.instructionsDigest !== context.snapshot.instructionsDigest
    || after.files.length !== context.snapshot.files.length) throw new Error('Editing changed Git state, repository instructions or file membership');
  for (const before of context.snapshot.files) {
    const current = after.files.find(file => file.path === before.path);
    if (!current || current.sha256 === null && before.sha256 !== null || current.executable !== before.executable
      || current.sha256 !== before.sha256 && !context.policy.files.some(path => key(path) === key(before.path))) throw new Error('Editing changed content outside the explicit file policy');
  }
  for (const path of context.policy.files) checkedFile(context, path);
}

export const editingInstructions = `You are implementing an approved Grampus task. Use only Read, Edit and Write on the supplied repository files. Only explicitly authorized files may be edited. Do not run commands, delegate, use external tools, change repository instructions, or claim tests, acceptance or completion. Follow the supplied repository instructions within this tool policy. Return the supplied JSON response format: kind=message with a concise change summary, or kind=question with stable question ids and choices if consequential information is missing. Include text, questions and findings; unused arrays are empty.`;
