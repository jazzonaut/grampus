// Owns opt-in directory grants. Grants authorise bounded file actions, never shell, Git or control files.
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { editLimits } from '../config/limits.js';

/** Portable file paths exclude aliases, Windows devices and repository/provider controls. */
export function isEditablePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    !!path &&
    path.length <= editLimits.pathCharacters &&
    !isAbsolute(path) &&
    !/[\\:<>"|?*]/.test(path) &&
    ![...path].some(character => character.charCodeAt(0) < 0x20) &&
    !path
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
          /^(\.git|\.claude|\.codex|\.grampus|AGENTS\.md|CLAUDE\.md)$/i.test(part),
      )
  );
}

/** Approval binds the directory, selectable file kinds and permitted actions. Existing limits still apply. */
export const directoryScopeSchema = z.strictObject({
  path: z.string().refine(isEditablePath),
  actions: z
    .array(z.enum(['edit', 'create', 'delete']))
    .min(1)
    .max(editLimits.directoryActions)
    .refine(items => new Set(items).size === items.length),
  suffixes: z
    .array(
      z
        .string()
        .max(editLimits.pathCharacters)
        .regex(/^\.[a-zA-Z0-9.]+$/),
    )
    .min(1)
    .max(editLimits.directorySuffixes),
});
export type DirectoryScope = z.infer<typeof directoryScopeSchema>;

/** Segment-aware matching never lets a grant escape its directory or authorise control files. */
export function directoryAllows(
  scopes: readonly DirectoryScope[] | undefined,
  action: DirectoryScope['actions'][number],
  path: string,
): boolean {
  if (!isEditablePath(path)) return false;
  const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return (
    scopes?.some(
      scope =>
        key(path).startsWith(`${key(scope.path)}/`) &&
        scope.actions.includes(action) &&
        scope.suffixes.some(suffix => key(path).endsWith(key(suffix))),
    ) ?? false
  );
}
