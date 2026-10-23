// Resolve repository preparation and mandatory verification from the immutable base commit.
import { z } from 'zod';
import { specLimits } from '../config/limits.js';
import { checkDefinitionSchema, type CheckDefinition } from '../domain/spec.js';
import { git } from '../git/git.js';

const configuration = z
  .object({
    setup: checkDefinitionSchema.nullable().optional(),
    checks: z.array(checkDefinitionSchema).min(1).max(specLimits.checks).optional(),
  })
  .strict();

const nodeProject = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

function packageManager(project: z.infer<typeof nodeProject> | null, files: readonly string[]): string {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(project?.packageManager ?? '')?.[1];
  if (declared) return declared;
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun';
  return 'npm';
}

async function inferredVerification(cwd: string, sha: string, files: readonly string[]) {
  const project = files.includes('package.json')
    ? nodeProject.parse(JSON.parse(await git(cwd, ['show', `${sha}:package.json`])))
    : null;
  const script = project?.scripts?.['verify'] ? 'verify' : project?.scripts?.['check'] ? 'check' : null;
  return {
    checks: script
      ? [{ name: 'Repository verification', command: `${packageManager(project, files)} run ${script}` }]
      : [],
    source: script
      ? `root ${script} script at the base commit`
      : 'no repository verification detected; configure checks in grampus.json',
  };
}

/** Snapshot once, before workers can alter package scripts or configuration. Explicit checks replace inference. */
export async function repositoryConfiguration(
  cwd: string,
  sha: string,
): Promise<{
  command: CheckDefinition | null;
  source: string;
  verification: { checks: CheckDefinition[]; source: string };
}> {
  const files = (await git(cwd, ['ls-tree', '--name-only', sha])).split(/\r?\n/);
  const explicit = files.includes('grampus.json')
    ? configuration.parse(JSON.parse(await git(cwd, ['show', `${sha}:grampus.json`])))
    : {};
  const install = files.includes('pnpm-lock.yaml')
    ? 'pnpm install --frozen-lockfile'
    : files.includes('package-lock.json')
      ? 'npm ci'
      : null;
  const command =
    explicit.setup !== undefined ? explicit.setup : install ? { name: 'Install dependencies', command: install } : null;
  const source =
    explicit.setup !== undefined
      ? 'grampus.json at the base commit'
      : install
        ? 'root lockfile at the base commit'
        : 'no repository setup';
  if (explicit.checks) {
    if (new Set(explicit.checks.map(check => check.name)).size !== explicit.checks.length)
      throw new Error('Repository check names in grampus.json must be unique.');
    if (new Set(explicit.checks.map(check => check.command.trim())).size !== explicit.checks.length)
      throw new Error('Repository check commands in grampus.json must be unique.');
    return { command, source, verification: { checks: explicit.checks, source: 'grampus.json at the base commit' } };
  }
  return { command, source, verification: await inferredVerification(cwd, sha, files) };
}
