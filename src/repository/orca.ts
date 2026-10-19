// Owns the Orca CLI client: workspace lifecycle and identity checks, plus optional desktop presentation.
// Workspace creation is never replayed; local instance keys and complete listings fence recovery.
// Card updates use the supported CLI, never Orca metadata files or provider/terminal input.
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
  orcaTabCreatedSchema,
  orcaTabsSchema,
  parseOrca,
} from './orca-protocol.js';

/** The Orca CLI to run: `ORCA_CLI_COMMAND`, else `orca-dev` for a development Orca, else the platform's name. */
export function orcaExecutable(): string {
  return (
    process.env.ORCA_CLI_COMMAND ??
    (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' ? 'orca-ide' : 'orca')
  );
}

/**
 * A validated local Orca worktree. `identityKey` and `instanceId` identify this particular instance, so a
 * worktree removed and recreated under the same name is a different worktree. `name` is Orca's display name
 * and `comment` carries the reservation marker Grampus set at creation.
 */
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

/** One worktree creation: a unique name and comment marker let recovery find its outcome without replaying it. */
export interface OrcaCreateRequest {
  repoId: string;
  name: string;
  baseCommit: string;
  marker: string;
}

/** Display-only metadata copied from Grampus; none of it establishes workflow success. */
export interface OrcaCard {
  title: string;
  comment: string;
  status: 'todo' | 'in-progress' | 'in-review' | 'completed';
  attention: boolean;
}

/** Optional desktop operations, separate from worktree lifecycle and provider execution. */
export interface OrcaDesktopClient {
  show(repository: string, identityKey: string): Promise<OrcaWorktree>;
  setCard(repository: string, identityKey: string, card: OrcaCard): Promise<void>;
  openDashboard(repository: string, url: string, identityKey?: string): Promise<void>;
}

/** The Orca operations `Workspaces` relies on; `OrcaCli` is the implementation. Each call throws on refusal. */
export interface OrcaWorkspaceClient {
  preflight(repository: string): Promise<{ id: string; path: string }>;
  create(repository: string, request: OrcaCreateRequest): Promise<OrcaWorktree>;
  list(repository: string, repoId: string): Promise<OrcaWorktree[]>;
  show(repository: string, identityKey: string): Promise<OrcaWorktree>;
}

/**
 * Validate one reported worktree. The host fields are checked before anything else so a remote worktree
 * is refused before its other fields are trusted; then the shape, and then the identity invariants.
 */
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
          // A failed exit that still printed output is passed on: it may be a JSON refusal envelope.
          if (error && !stdout.trim())
            reject(new Error('Orca command failed or timed out; its host outcome may be unknown'));
          else resolve(stdout);
        },
      );
      child.stdin?.end();
    });
}

/**
 * Orca through its CLI. Every response is parsed against the pinned contract in orca-protocol.ts; a
 * malformed one is a `BoundaryError`, an `ok: false` envelope is `Orca refused the request: <code>`, and a
 * failed or timed-out command is an error whose host outcome may be unknown.
 */
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

  /**
   * Read-only checks before any Orca mutation: the CLI must offer the creation flags Grampus passes, the
   * repository must be a local Git repository known to Orca, and a complete local worktree listing must
   * parse. Returns Orca's repository id and path.
   *
   * @throws Error when a flag is missing, the repository is not local Git, or the listing is incomplete.
   */
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

  /**
   * One `worktree create` with no parent worktree, setup skipped and no agent launched. Called once per
   * reservation: a failure here leaves the outcome unknown and is never retried.
   */
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

  /**
   * Every worktree of one repository. A truncated listing, a count mismatch or any other or omitted host
   * is refused, because recovery decides from absence and a partial view could hide the reserved worktree.
   */
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

  /** The worktree with this exact instance identity; `Workspaces.inspect` uses it to re-verify a workspace. */
  async show(repository: string, identityKey: string): Promise<OrcaWorktree> {
    const result = await this.request(repository, 'worktree show', ['--worktree', `identity:${identityKey}`]);
    return worktree('worktree show', parseOrca('worktree show', orcaWorktreeResultSchema, result).worktree);
  }

  /** Updates only the named instance's presentation. Never clears a person's unread indicator. */
  async setCard(repository: string, identityKey: string, card: OrcaCard): Promise<void> {
    await this.request(repository, 'worktree set', [
      '--worktree',
      `identity:${identityKey}`,
      '--display-name',
      card.title,
      '--comment',
      card.comment,
      '--workspace-status',
      card.status,
      ...(card.attention ? ['--unread'] : []),
    ]);
  }

  /** Reauthenticates an existing dashboard tab or opens one, then focuses its exact page handle. */
  async openDashboard(repository: string, url: string, identityKey?: string): Promise<void> {
    if (process.env.ORCA_PAIRING_CODE || process.env.ORCA_ENVIRONMENT)
      throw new Error('The dashboard requires the local Orca desktop without remote overrides');
    const destination = new URL(url);
    if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1')
      throw new Error('Orca dashboard navigation requires a loopback Grampus URL');
    const target = identityKey ? ['--worktree', `identity:${identityKey}`] : [];
    const { tabs } = parseOrca('tab list', orcaTabsSchema, await this.request(repository, 'tab list', target));
    const tab = tabs.find(tab => {
      try {
        const address = new URL(tab.url);
        return address.origin === destination.origin && address.pathname === destination.pathname;
      } catch {
        return false;
      }
    });
    if (tab) {
      await this.request(repository, 'goto', [...target, '--page', tab.browserPageId, '--url', url]);
      await this.request(repository, 'tab switch', [...target, '--page', tab.browserPageId, '--focus']);
      return;
    }
    const created = parseOrca(
      'tab create',
      orcaTabCreatedSchema,
      await this.request(repository, 'tab create', [...target, '--url', url]),
    );
    await this.request(repository, 'tab switch', [...target, '--page', created.browserPageId, '--focus']);
  }
}
