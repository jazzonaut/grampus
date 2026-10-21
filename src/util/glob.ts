// Minimal repository glob matching for protected paths and test patterns: `**` crosses directories,
// `*` and `?` stay within one path segment. Paths use forward slashes and are relative to the repository.

/** Compile a glob such as `src/**\/*.test.ts` to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? '';
    if (char === '*' && glob[index + 1] === '*') {
      const slashFollows = glob[index + 2] === '/';
      pattern += slashFollows ? '(?:.*/)?' : '.*';
      index += slashFollows ? 2 : 1;
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** Whether a repository path matches any of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  const normalised = path.replaceAll('\\', '/');
  return globs.some(glob => globToRegExp(glob).test(normalised));
}
