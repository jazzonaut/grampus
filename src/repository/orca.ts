import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { processLimits } from '../config/limits.js';
import {
  orcaEnvelopeSchema,
  orcaHostSchema,
  orcaJson,
  orcaRepoShowSchema,
  orcaWorktreeListSchema,
  orcaWorktreeResultSchema,
  orcaWorktreeSchema,
  parseOrca,
} from './orca-protocol.js';

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

function worktree(command: string, value: unknown): OrcaWorktree {
  const host = parseOrca(command, orcaHostSchema, value);
  if (host.identity.executionHostId !== 'local' || host.hostId !== 'local')
    throw new Error('Only local Orca workspaces are supported');
  const raw = parseOrca(command, orcaWorktreeSchema, value, 'Malformed Orca worktree identity or path');
  const { instanceId, key: identityKey } = raw.identity;
  if (
    !isAbsolute(raw.path) ||
    !raw.id.startsWith(`${raw.repoId}::`) ||
    !raw.branch.startsWith('refs/heads/') ||
    raw.instanceId !== instanceId ||
    identityKey !== `wt2:local:${instanceId}`
  ) {
    throw new Error('Invalid Orca worktree identity');
  }
  return {
    id: raw.id,
    repoId: raw.repoId,
    path: raw.path,
    branch: raw.branch,
    identityKey,
    instanceId,
    name: raw.displayName,
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
        {
          cwd,
          windowsHide: true,
          timeout: processLimits.orcaTimeoutMs,
          maxBuffer: processLimits.toolOutputBytes,
          encoding: 'utf8',
        },
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

  /** Runs one command and returns its `result`; `command` names it in errors (`repo show`, `worktree list`). */
  private async request(cwd: string, command: string, args: string[]): Promise<unknown> {
    const response = parseOrca(
      command,
      orcaEnvelopeSchema,
      orcaJson(command, await this.run(cwd, [...command.split(' '), ...args, '--json'])),
    );
    if (!response.ok) {
      const code = response.error?.code;
      throw new Error(
        `Orca refused the request: ${typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'unknown'}`,
      );
    }
    return response.result;
  }

  async preflight(repository: string): Promise<{ id: string; path: string }> {
    const help = await this.run(repository, ['worktree', 'create', '--help']);
    if (!['--setup', '--no-parent', '--base-branch', '--comment', '--json'].every(flag => help.includes(flag))) {
      throw new Error('Orca CLI lacks required workspace controls; update Orca before creating workspaces');
    }
    const { repo } = parseOrca(
      'repo show',
      orcaRepoShowSchema,
      await this.request(repository, 'repo show', ['--repo', `path:${repository}`]),
    );
    if (repo.kind !== 'git' || !isAbsolute(repo.path)) throw new Error('Orca must reference a local Git repository');
    const result = { id: repo.id, path: repo.path };
    // Verify modern local identity responses before making any mutation.
    await this.list(repository, result.id);
    return result;
  }

  async create(repository: string, request: OrcaCreateRequest): Promise<OrcaWorktree> {
    const result = await this.request(repository, 'worktree create', [
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
    return worktree('worktree create', parseOrca('worktree create', orcaWorktreeResultSchema, result).worktree);
  }

  async list(repository: string, repoId: string): Promise<OrcaWorktree[]> {
    const incomplete = 'Orca worktree listing is incomplete or includes another host';
    const result = parseOrca(
      'worktree list',
      orcaWorktreeListSchema,
      await this.request(repository, 'worktree list', ['--repo', `id:${repoId}`]),
      incomplete,
    );
    if (
      result.truncated ||
      result.totalCount !== result.worktrees.length ||
      result.hostScope.omittedHostIds.length !== 0 ||
      result.hostScope.hostIds.some(id => id !== 'local')
    ) {
      throw new Error(incomplete);
    }
    const entries = result.worktrees.map(entry => worktree('worktree list', entry));
    if (entries.some(entry => entry.repoId !== repoId)) throw new Error('Orca returned a different repository');
    return entries;
  }

  async show(repository: string, identityKey: string): Promise<OrcaWorktree> {
    const result = await this.request(repository, 'worktree show', ['--worktree', `identity:${identityKey}`]);
    return worktree('worktree show', parseOrca('worktree show', orcaWorktreeResultSchema, result).worktree);
  }
}
