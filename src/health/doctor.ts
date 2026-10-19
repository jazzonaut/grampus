// Owns `doctor`: inference-free checks of the programs Grampus actually runs. Codex and Claude are
// resolved by providers/executables.ts, the functions the adapters use, and each handshake is the
// adapter's own: the Codex app-server is started with the connection's arguments and environment and
// initialised with the same capabilities; Claude is a real `ClaudeSession` (same executable, options and
// environment) that answers control requests but is never sent a turn. The result is a typed
// `HealthReport` with one row per capability; storing it is health.ts's job.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { command } from '../process/process.js';
import { orcaExecutable } from '../repository/orca.js';
import { applicationVersion, applicationRoot } from '../config/runtime.js';
import { healthLimits } from '../config/limits.js';
import {
  claudeExecutable,
  claudeSdk,
  codexExecutable,
  findExecutable,
  normaliseVersion,
  providerRuntime,
  type ProviderExecutable,
} from '../providers/executables.js';
import { codexHandshake, hasCodexSubscription, listCodexMcpServers, startCodexAppServer } from '../providers/codex.js';
import { ClaudeSession, hasClaudeSubscription } from '../providers/claude.js';
import { orcaCurrentSchema, orcaEnvelopeSchema, orcaJson, parseOrca } from '../repository/orca-protocol.js';
import { healthFingerprint, integrationStatus, sanitiseDetail } from './health.js';
import type {
  Capability,
  CapabilityName,
  HealthReport,
  HealthStatus,
  IntegrationHealth,
  IntegrationId,
} from './health-record.js';

/** What `doctor` exercises beyond the default checks. */
export interface DoctorOptions {
  /** Also ask Orca for the current worktree; only meaningful inside an Orca workspace. */
  orca: boolean;
}

/**
 * A helper command run from the temporary directory, so a check never holds the caller's working
 * directory open (Windows cannot remove a directory a process runs in, even an orphaned one).
 */
const neutral = (file: string, args: string[]) => command(file, args, healthLimits.handshakeTimeoutMs, tmpdir());

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A failure's status: timeouts may pass on the next check, anything else is a failure. */
function failureStatus(error: unknown): HealthStatus {
  return /timed? ?out|timeout/i.test(message(error)) ? 'temporarily_unavailable' : 'failed';
}

const row = (name: CapabilityName, status: HealthStatus, detail: string): Capability => ({
  name,
  status,
  detail: sanitiseDetail(detail),
});

const failedRow = (name: CapabilityName, error: unknown): Capability => row(name, failureStatus(error), message(error));

/** Reject when `promise` has not settled within the health deadline; the work itself is closed by its owner. */
async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out`)), healthLimits.handshakeTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One integration's result; its status derives from the capability rows, never set separately. */
function integration(
  id: IntegrationId,
  required: boolean,
  facts: { executable: string | null; version: string | null; sdkVersion?: string | null },
  capabilities: Capability[],
): IntegrationHealth {
  const sdkVersion = facts.sdkVersion ?? null;
  return {
    id,
    required,
    status: integrationStatus(capabilities),
    executable: facts.executable,
    version: facts.version,
    sdkVersion,
    fingerprint: `${id} ${facts.version ?? 'unknown'}${sdkVersion ? ` sdk ${sdkVersion}` : ''}`,
    capabilities,
  };
}

function executableRow(executable: ProviderExecutable): Capability {
  return executable.path
    ? row('executable', 'healthy', `${executable.path} (${executable.source})`)
    : row('executable', 'failed', executable.problem ?? 'Executable not found');
}

const notAttempted = (name: CapabilityName) => row(name, 'untested', 'Not attempted without an executable');
const noInference = row('inference', 'untested', 'Doctor never sends a turn, so model access is not tested');

function serverList(servers: readonly { name: string; status: string }[]): string {
  if (!servers.length) return 'No MCP servers configured';
  const listed = servers.slice(0, healthLimits.mcpServersListed).map(server => `${server.name} (${server.status})`);
  const more = servers.length - listed.length;
  return `${servers.length} configured: ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Codex: the resolved executable, its version, an app-server handshake with `account/read`, the
 * subscription login and the configured MCP servers. Without an executable nothing else is attempted.
 */
async function codex(): Promise<IntegrationHealth> {
  const executable = codexExecutable();
  const runtime = providerRuntime('codex');
  const facts = { executable: executable.path, version: runtime.version };
  if (!executable.path)
    return integration('codex', true, facts, [
      executableRow(executable),
      notAttempted('version'),
      notAttempted('handshake'),
      notAttempted('auth'),
      notAttempted('mcp'),
      noInference,
    ]);
  const rows = [
    executableRow(executable),
    runtime.version
      ? row('version', 'healthy', `codex-cli ${runtime.version}`)
      : row('version', 'failed', 'codex --version reported no version'),
  ];
  const rpc = startCodexAppServer(tmpdir());
  try {
    const handshake = await codexHandshake(rpc);
    rows.push(row('handshake', 'healthy', 'app-server initialize (experimentalApi) and account/read succeeded'));
    rows.push(
      hasCodexSubscription(handshake)
        ? row('auth', 'healthy', 'ChatGPT subscription login')
        : row(
            'auth',
            'auth_unavailable',
            handshake.account
              ? `Signed in with ${handshake.account.type}; Grampus requires a ChatGPT subscription login`
              : 'Not signed in; run codex login with a ChatGPT account',
          ),
    );
    try {
      rows.push(row('mcp', 'healthy', serverList(await listCodexMcpServers(rpc, null))));
    } catch (error) {
      rows.push(failedRow('mcp', error));
    }
  } catch (error) {
    rows.push(failedRow('handshake', error), row('auth', 'untested', 'Handshake did not complete'));
    rows.push(row('mcp', 'untested', 'Handshake did not complete'));
  } finally {
    await rpc.close().catch(() => {});
  }
  rows.push(noInference);
  return integration('codex', true, facts, rows);
}

/**
 * Claude: the resolved executable and its version, the Agent SDK control handshake, the subscription
 * login and the configured MCP servers. A bundled executable whose version differs from the one the
 * pinned SDK declares fails the version row.
 */
async function claude(): Promise<IntegrationHealth> {
  const executable = claudeExecutable();
  const runtime = providerRuntime('claude');
  const sdk = claudeSdk();
  const facts = { executable: executable.path, version: runtime.version, sdkVersion: sdk.version };
  if (!executable.path)
    return integration('claude', true, facts, [
      executableRow(executable),
      notAttempted('version'),
      notAttempted('handshake'),
      notAttempted('auth'),
      notAttempted('mcp'),
      noInference,
    ]);
  const bundledMismatch =
    executable.source === 'bundled' && sdk.claudeCodeVersion && runtime.version !== sdk.claudeCodeVersion
      ? `; the SDK expects ${sdk.claudeCodeVersion}`
      : '';
  const rows = [
    executableRow(executable),
    runtime.version
      ? row(
          'version',
          bundledMismatch ? 'failed' : 'healthy',
          `Claude Code ${runtime.version}, Agent SDK ${sdk.version}${bundledMismatch}`,
        )
      : row('version', 'failed', 'claude --version reported no version'),
  ];
  const abort = new AbortController();
  // The adapter's own session: identical executable, options and environment. No turn is ever sent.
  const session = new ClaudeSession({
    cwd: tmpdir(),
    providerSessionId: null,
    model: null,
    signal: abort.signal,
    emit: () => {},
  });
  try {
    const account = await bounded(session.accountInfo(), 'Claude accountInfo');
    rows.push(row('handshake', 'healthy', 'Agent SDK control handshake (accountInfo) succeeded'));
    rows.push(
      hasClaudeSubscription(account)
        ? row('auth', 'healthy', `First-party ${account.subscriptionType ?? 'subscription'} login`)
        : row(
            'auth',
            'auth_unavailable',
            `Provider ${account.apiProvider ?? 'unknown'}, subscription ${account.subscriptionType ?? 'none'}, API key source ${account.apiKeySource ?? 'none'}; Grampus requires a first-party Claude subscription login`,
          ),
    );
    try {
      // Grampus's own servers (`grampus_*`) are left out, so the row reports the user's configuration.
      const servers = (await bounded(session.mcpStatus(), 'Claude MCP status')).filter(
        server => !server.name.startsWith('grampus_'),
      );
      const failing = servers.filter(server => server.status === 'failed');
      rows.push(row('mcp', failing.length ? 'temporarily_unavailable' : 'healthy', serverList(servers)));
    } catch (error) {
      rows.push(failedRow('mcp', error));
    }
  } catch (error) {
    rows.push(failedRow('handshake', error), row('auth', 'untested', 'Handshake did not complete'));
    rows.push(row('mcp', 'untested', 'Handshake did not complete'));
  } finally {
    abort.abort();
    await session.close().catch(() => {});
  }
  rows.push(noInference);
  return integration('claude', true, facts, rows);
}

async function git(): Promise<IntegrationHealth> {
  const path = findExecutable('git');
  try {
    const version = normaliseVersion(await neutral('git', ['--version']));
    return integration('git', true, { executable: path, version }, [
      row('executable', 'healthy', path ?? 'git'),
      row('version', version ? 'healthy' : 'failed', version ? `git ${version}` : 'git --version reported no version'),
    ]);
  } catch (error) {
    return integration('git', true, { executable: path, version: null }, [
      failedRow('executable', error),
      row('version', 'untested', 'Git could not be started'),
    ]);
  }
}

const enginesSchema = z.looseObject({ engines: z.looseObject({ node: z.string() }) });

/** This Node: its major version against the first number of `engines.node`, and whether `node:sqlite` opens. */
function node(): IntegrationHealth {
  const version = process.versions.node;
  const required = enginesSchema.parse(JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8'))).engines
    .node;
  const minimum = Number(/\d+/.exec(required)?.[0] ?? 0);
  const major = Number(version.split('.')[0]);
  let sqlite: Capability;
  try {
    new DatabaseSync(':memory:').close();
    sqlite = row('sqlite', 'healthy', 'node:sqlite opens a database');
  } catch (error) {
    sqlite = failedRow('sqlite', error);
  }
  return integration('node', true, { executable: process.execPath, version }, [
    row('executable', 'healthy', process.execPath),
    row('version', major >= minimum ? 'healthy' : 'failed', `Node ${version}; Grampus requires ${required}`),
    sqlite,
  ]);
}

/**
 * Windows PowerShell and the native supervisor sources it runs. The supervisor row is at best
 * `untested`: its files are present, but the Job Object helper is only compiled by a real check.
 */
async function powershell(): Promise<IntegrationHealth> {
  const path = resolve(
    process.env.SystemRoot ?? process.env.WINDIR ?? '',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const native = ['check.cs', 'check.ps1', 'process.ps1'].map(file =>
    fileURLToPath(new URL(`../../../src/process/native/${file}`, import.meta.url)),
  );
  const missing = native.filter(file => !existsSync(file));
  const supervisor = missing.length
    ? row('supervisor', 'failed', `Missing supervisor files: ${missing.join(', ')}`)
    : row(
        'supervisor',
        'untested',
        'Supervisor files present; the Job Object helper is compiled and exercised by the first supervised check',
      );
  if (!existsSync(path))
    return integration('powershell', true, { executable: null, version: null }, [
      row('executable', 'failed', `Windows PowerShell not found at ${path}`),
      row('version', 'untested', 'Not attempted without an executable'),
      supervisor,
    ]);
  try {
    const version = normaliseVersion(
      await neutral(path, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']),
    );
    return integration('powershell', true, { executable: path, version }, [
      row('executable', 'healthy', path),
      row('version', version ? 'healthy' : 'failed', version ? `Windows PowerShell ${version}` : 'No version reported'),
      supervisor,
    ]);
  } catch (error) {
    return integration('powershell', true, { executable: path, version: null }, [
      row('executable', 'healthy', path),
      failedRow('version', error),
      supervisor,
    ]);
  }
}

/**
 * Orca is optional: required (a missing executable fails) only with `options.orca`, otherwise a
 * missing executable is `not_configured` and the worktree handshake is not attempted.
 */
async function orca(options: DoctorOptions): Promise<IntegrationHealth> {
  const name = orcaExecutable();
  const path = /[\\/]/.test(name) ? (existsSync(name) ? resolve(name) : null) : findExecutable(name);
  if (!path)
    return integration('orca', options.orca, { executable: null, version: null }, [
      row('executable', options.orca ? 'failed' : 'not_configured', `${name} is not installed; Orca is optional`),
    ]);
  let version: string | null = null;
  const rows: Capability[] = [row('executable', 'healthy', path)];
  try {
    version = normaliseVersion(await neutral(path, ['--version']));
    rows.push(row('version', version ? 'healthy' : 'failed', version ? `Orca ${version}` : 'No version reported'));
  } catch (error) {
    rows.push(failedRow('version', error));
  }
  if (!options.orca) rows.push(row('handshake', 'untested', 'Run doctor --orca inside an Orca workspace to test it'));
  else
    try {
      const response = parseOrca(
        'worktree current',
        orcaEnvelopeSchema,
        orcaJson(
          'worktree current',
          await command(path, ['worktree', 'current', '--json'], healthLimits.handshakeTimeoutMs),
        ),
      );
      if (!response.ok) throw new Error('Orca could not resolve the current worktree');
      const current = parseOrca('worktree current', orcaCurrentSchema, response.result);
      rows.push(
        current.worktree?.id
          ? row('handshake', 'healthy', 'Orca recognised the current worktree')
          : row('handshake', 'failed', 'Orca did not recognise the current worktree'),
      );
    } catch (error) {
      rows.push(failedRow('handshake', error));
    }
  return integration('orca', options.orca, { executable: path, version }, rows);
}

/**
 * Check every integration without inference. Checks run concurrently and record handshake and command
 * failures as capability rows rather than throwing. PowerShell is checked on Windows only.
 */
export async function doctor(options: DoctorOptions = { orca: false }): Promise<HealthReport> {
  const started = Date.now();
  const integrations = await Promise.all([
    codex(),
    claude(),
    git(),
    Promise.resolve(node()),
    ...(process.platform === 'win32' ? [powershell()] : []),
    orca(options),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    application: applicationVersion,
    fingerprint: healthFingerprint(integrations),
    integrations,
  };
}
