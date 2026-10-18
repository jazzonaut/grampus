import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { validateBrief, type Brief } from './workflow.js';
import { validateEditPolicy, type EditPolicy } from './edit-policy.js';
import { gitText } from './delivery-git.js';
import type { Provider } from './agents/types.js';
import { pinnedContext, pinnedRepository } from './repository-context.js';
import { normalizeReferences, type ReferenceFolder } from './reference-folders.js';

export interface GuidedCommand { name: string; file: string; args: string[]; timeoutMs: number }
export interface GuidedSlice {
  scope: Pick<EditPolicy, 'files' | 'create' | 'delete'>;
  validation: GuidedCommand;
  acceptance: GuidedCommand & { expectedStdout: string };
  message: string;
  mode: 'commit' | 'no_change';
}
export interface GuidedPlan {
  references?: ReferenceFolder[];
  context?: { files: string[]; inventoryDigest: string; totalFiles: number; totalBytes: number; exploration?: boolean };
  brief: Brief;
  workspace: { repo: string; base: string; adapter: 'git' | 'orca'; path?: string };
  implementation: { provider: Provider; model: string | null; timeoutMs: number };
  review: { provider: Provider; model: string | null; timeoutMs: number };
  slices: GuidedSlice[];
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`Invalid ${label}; allowed fields: ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, limit = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) throw new Error(`${label} must be nonempty text (at most ${limit} bytes)`);
  return value;
}
function timeout(value: unknown): number {
  const result = value ?? 120000;
  if (!Number.isSafeInteger(result) || Number(result) < 100 || Number(result) > 600000) throw new Error('Timeout must be 100–600000 ms');
  return Number(result);
}
function command(value: unknown, acceptance: boolean): GuidedCommand & { expectedStdout?: string } {
  const item = object(value, ['name', 'file', 'args', 'timeoutMs', ...(acceptance ? ['expectedStdout'] : [])], acceptance ? 'acceptance command' : 'validation command');
  const file = item.file === 'node' ? process.execPath : text(item.file, 'Command executable');
  if (!isAbsolute(file) || !statSync(file).isFile() || (process.platform === 'win32' && !file.toLowerCase().endsWith('.exe'))) throw new Error('Command file must be "node" or an absolute executable path');
  if (!Array.isArray(item.args) || item.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || JSON.stringify(item.args).length > 24000) throw new Error('Command args must be an array of strings (at most 24000 encoded characters)');
  if (acceptance && (typeof item.expectedStdout !== 'string' || Buffer.byteLength(item.expectedStdout) > 64 * 1024)) throw new Error('Acceptance requires expectedStdout (at most 64 KiB)');
  return { name: text(item.name ?? (acceptance ? 'Acceptance' : 'Validation'), 'Command name', 200), file, args: item.args as string[], timeoutMs: timeout(item.timeoutMs),
    ...(acceptance ? { expectedStdout: item.expectedStdout as string } : {}) };
}
function agent(value: unknown, defaultProvider: Provider): GuidedPlan['implementation'] {
  const item = object(value ?? {}, ['provider', 'model', 'timeoutMs'], 'agent');
  const provider = item.provider ?? defaultProvider;
  if (provider !== 'codex' && provider !== 'claude') throw new Error('Provider must be codex or claude');
  return { provider, model: item.model == null ? null : text(item.model, 'Model', 200), timeoutMs: timeout(item.timeoutMs) };
}

/** Normalize once; approval covers this exact plan, including checks, paths and pinned base. */
export function normalizeGuidedPlan(input: unknown, directory = process.cwd()): GuidedPlan {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 1024 * 1024) throw new Error('Guided plan exceeds 1 MiB');
  const value = object(input, ['brief', 'workspace', 'implementation', 'review', 'slices', 'context', 'references'], 'guided plan');
  const references = normalizeReferences(value.references);
  const brief = structuredClone(object(value.brief, ['title', 'outcome', 'criteria', 'plan', 'slices'], 'brief')) as unknown as Brief;
  validateBrief(brief);
  const workspace = object(value.workspace, ['repo', 'base', 'adapter', 'path'], 'workspace');
  const adapter = workspace.adapter ?? 'git';
  if (adapter !== 'git' && adapter !== 'orca') throw new Error('Workspace adapter must be git or orca');
  if (adapter === 'orca' && workspace.path !== undefined) throw new Error('Orca chooses the workspace path; omit path');
  const repo = realpathSync.native(gitText(resolve(directory, text(workspace.repo, 'Repository')), 'rev-parse', '--show-toplevel'));
  const base = gitText(repo, 'rev-parse', '--verify', '--end-of-options', `${text(workspace.base ?? 'HEAD', 'Base ref')}^{commit}`);
  const contextInput = value.context === undefined ? null : object(value.context, ['files', 'inventoryDigest', 'totalFiles', 'totalBytes', 'exploration'], 'repository context');
  if (contextInput?.exploration !== undefined && typeof contextInput.exploration !== 'boolean') throw new Error('Context exploration must be boolean');
  const exploration = contextInput?.exploration !== false;
  if (references.length && !exploration) throw new Error('Reference folders require repository exploration');
  if (contextInput && !Array.isArray(contextInput.files)) throw new Error('Repository context requires an exact files array');
  const selected = pinnedContext(repo, base, contextInput?.files ?? (exploration ? [] : undefined), `${brief.title} ${brief.outcome}`);
  if (contextInput?.inventoryDigest !== undefined && contextInput.inventoryDigest !== selected.summary.inventoryDigest) throw new Error('Pinned repository inventory changed');
  const context = { files: selected.summary.selected, exploration, inventoryDigest: selected.summary.inventoryDigest,
    totalFiles: selected.summary.totalFiles, totalBytes: selected.summary.totalBytes };
  let path: string | undefined;
  if (adapter === 'git') {
    const target = resolve(directory, text(workspace.path, 'Workspace path'));
    path = join(realpathSync.native(dirname(target)), basename(target));
    if (existsSync(path)) throw new Error('Workspace destination must not exist');
  }
  const implementation = agent(value.implementation, 'codex');
  const review = agent(value.review, implementation.provider === 'codex' ? 'claude' : 'codex');
  if (review.provider === implementation.provider) throw new Error('The guided workflow requires the other provider for independent review');
  if (!Array.isArray(value.slices) || value.slices.length !== (brief.slices?.length ?? 1)) throw new Error('Supply one execution configuration for each approved slice (one for an unsliced brief)');
  const earlierCreations = new Set<string>();
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const present = new Map(pinnedRepository(repo, base).entries.map(entry => [pathKey(entry.path), entry.path]));
  const deleted = new Set<string>();
  const slices = value.slices.map((raw): GuidedSlice => {
    const item = object(raw, ['scope', 'validation', 'acceptance', 'message', 'mode'], 'slice configuration');
    const mode = item.mode ?? 'commit';
    if (mode !== 'commit' && mode !== 'no_change') throw new Error('Delivery mode must be commit or no_change');
    const scope = structuredClone(object(item.scope, ['files', 'create', 'delete'], 'file scope')) as unknown as GuidedSlice['scope'];
    if (mode === 'no_change') {
      if (!Array.isArray(scope.files) || scope.files.length || scope.create !== undefined || scope.delete !== undefined) throw new Error('No-change delivery requires scope: { files: [] }');
    } else validateEditPolicy({ ...scope, artifact: `sha256:${'0'.repeat(64)}`, instructionsDigest: '0'.repeat(64) });
    for (const path of [...scope.files, ...(scope.delete ?? [])]) {
      if (present.get(pathKey(path)) !== path) throw new Error(`File action is absent before this slice (use its exact path): ${path}`);
      if (!exploration && !context.files.includes(path) && !earlierCreations.has(path)) throw new Error(`Select ${path} as repository context before approving its file action`);
    }
    for (const path of scope.create ?? []) {
      if (present.has(pathKey(path))) throw new Error(`Creation path already exists before this slice: ${path}`);
      if (deleted.has(pathKey(path))) throw new Error(`Cannot recreate a path deleted by an earlier slice: ${path}`);
      present.set(pathKey(path), path); earlierCreations.add(path);
    }
    for (const path of scope.delete ?? []) {
      present.delete(pathKey(path)); deleted.add(pathKey(path)); earlierCreations.delete(path);
    }
    const message = text(item.message, 'Commit message', 8192);
    if (/Grampus-Delivery:/i.test(message)) throw new Error('Commit message cannot contain the reserved Grampus-Delivery marker');
    return { scope, mode, validation: command(item.validation, false), acceptance: command(item.acceptance, true) as GuidedSlice['acceptance'], message };
  });
  return { brief, workspace: { repo, base, adapter, ...(path ? { path } : {}) }, implementation, review, slices, context, ...(references.length ? { references } : {}) };
}

export function guidedPlanDigest(plan: GuidedPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
