import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export function orcaExecutable(): string {
  return (
    process.env.ORCA_CLI_COMMAND ??
    (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' ? 'orca-ide' : 'orca')
  );
}

export interface OrcaWorktree {
  id: string;
  repoId: string;
  path: string;
  branch: string;
  identityKey: string;
  instanceId: string;
  name: string;
  comment: string;
  baseRef: string | null;
  isMain: boolean;
  archived: boolean;
}

export interface OrcaCreateRequest {
  repoId: string;
  name: string;
  baseCommit: string;
  marker: string;
}

export interface OrcaWorkspaceClient {
  preflight(repository: string): Promise<{ id: string; path: string }>;
  create(repository: string, request: OrcaCreateRequest): Promise<OrcaWorktree>;
  list(repository: string, repoId: string): Promise<OrcaWorktree[]>;
  show(repository: string, identityKey: string): Promise<OrcaWorktree>;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Orca response');
  return value as ObjectValue;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing Orca identity or path');
  return value;
}

function worktree(value: unknown): OrcaWorktree {
  const raw = object(value);
  const identity = object(raw.identity);
  if (identity.executionHostId !== 'local' || raw.hostId !== 'local')
    throw new Error('Only local Orca workspaces are supported');
  const id = string(raw.id),
    repoId = string(raw.repoId),
    path = string(raw.path),
    branch = string(raw.branch);
  const instanceId = string(identity.instanceId),
    identityKey = string(identity.key);
  if (
    !isAbsolute(path) ||
    !id.startsWith(`${repoId}::`) ||
    !branch.startsWith('refs/heads/') ||
    raw.instanceId !== instanceId ||
    identityKey !== `wt2:local:${instanceId}` ||
    typeof raw.isMainWorktree !== 'boolean' ||
    typeof raw.isArchived !== 'boolean'
  ) {
    throw new Error('Invalid Orca worktree identity');
  }
  return {
    id,
    repoId,
    path,
    branch,
    identityKey,
    instanceId,
    name: string(raw.displayName),
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    baseRef: typeof raw.baseRef === 'string' ? raw.baseRef : null,
    isMain: raw.isMainWorktree,
    archived: raw.isArchived,
  };
}

/** Injectable transport for protocol fixtures; production resolves one executable per client. */
export type OrcaTransport = (cwd: string, args: string[]) => Promise<string>;
function transport(executable: string): OrcaTransport {
  return (cwd, args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          // Orca may still be working after a transport timeout. Never retry a mutation here.
          if (error && !stdout.trim())
            reject(new Error('Orca command failed or timed out; its host outcome may be unknown'));
          else resolve(stdout);
        },
      );
      child.stdin?.end();
    });
}

export class OrcaCli implements OrcaWorkspaceClient {
  constructor(private readonly run: OrcaTransport = transport(orcaExecutable())) {}

  private async request(cwd: string, args: string[]): Promise<ObjectValue> {
    const response = object(JSON.parse(await this.run(cwd, [...args, '--json'])) as unknown);
    if (response.ok !== true) {
      const code = object(response.error).code;
      throw new Error(
        `Orca refused the request: ${typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'unknown'}`,
      );
    }
    return object(response.result);
  }

  async preflight(repository: string): Promise<{ id: string; path: string }> {
    const help = await this.run(repository, ['worktree', 'create', '--help']);
    if (!['--setup', '--no-parent', '--base-branch', '--comment', '--json'].every(flag => help.includes(flag))) {
      throw new Error('Orca CLI lacks required workspace controls; update Orca before creating workspaces');
    }
    const repo = object((await this.request(repository, ['repo', 'show', '--repo', `path:${repository}`])).repo);
    if (repo.kind !== 'git' || !isAbsolute(string(repo.path)))
      throw new Error('Orca must reference a local Git repository');
    const result = { id: string(repo.id), path: string(repo.path) };
    // Verify modern local identity responses before making any mutation.
    await this.list(repository, result.id);
    return result;
  }

  async create(repository: string, request: OrcaCreateRequest): Promise<OrcaWorktree> {
    const result = await this.request(repository, [
      'worktree',
      'create',
      '--repo',
      `id:${request.repoId}`,
      '--name',
      request.name,
      '--base-branch',
      request.baseCommit,
      '--comment',
      request.marker,
      '--no-parent',
      '--setup',
      'skip',
    ]);
    return worktree(result.worktree);
  }

  async list(repository: string, repoId: string): Promise<OrcaWorktree[]> {
    const result = await this.request(repository, ['worktree', 'list', '--repo', `id:${repoId}`]);
    const scope = object(result.hostScope);
    if (
      result.truncated !== false ||
      !Array.isArray(result.worktrees) ||
      result.totalCount !== result.worktrees.length ||
      !Array.isArray(scope.omittedHostIds) ||
      scope.omittedHostIds.length !== 0 ||
      !Array.isArray(scope.hostIds) ||
      scope.hostIds.some(id => id !== 'local')
    ) {
      throw new Error('Orca worktree listing is incomplete or includes another host');
    }
    const entries = result.worktrees.map(worktree);
    if (entries.some(entry => entry.repoId !== repoId)) throw new Error('Orca returned a different repository');
    return entries;
  }

  async show(repository: string, identityKey: string): Promise<OrcaWorktree> {
    return worktree(
      (await this.request(repository, ['worktree', 'show', '--worktree', `identity:${identityKey}`])).worktree,
    );
  }
}
