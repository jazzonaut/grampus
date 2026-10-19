// Owns how Grampus finds the provider programs it runs. The Codex and Claude adapters spawn exactly what
// these functions resolve, and `doctor` and session records report the same values, so a health result
// always describes the program a turn would start.
//
// Codex is found on PATH (or through `GRAMPUS_CODEX_COMMAND`). Only native executables are accepted,
// because the adapters spawn without a shell: an npm batch shim is reported, never run. Claude is the
// executable bundled with the pinned Agent SDK, resolved the way the SDK resolves it, unless
// `GRAMPUS_CLAUDE_COMMAND` names another one.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { processLimits } from '../config/limits.js';
import type { Provider } from './types.js';

/** Where an executable came from: an environment override, a PATH search or the pinned SDK package. */
export const executableSourceSchema = z.enum(['environment', 'path', 'bundled']);
export type ExecutableSource = z.infer<typeof executableSourceSchema>;

/** A resolved provider program. */
export interface ProviderExecutable {
  provider: Provider;
  /** What the adapter spawns: the absolute path when resolved, otherwise the configured name, which then fails to start. */
  command: string;
  /** Absolute path of the executable, or null when none was found. */
  path: string | null;
  source: ExecutableSource;
  /** Why no executable was found; null when `path` is set. */
  problem: string | null;
}

/**
 * The provider program recorded on each session and compared by health: executable, its reported
 * version and, for Claude, the pinned Agent SDK version. Unknown values are null, never guessed.
 */
export const providerRuntimeSchema = z.object({
  executable: z.string().nullable(),
  source: executableSourceSchema,
  version: z.string().nullable(),
  sdkVersion: z.string().nullable(),
});
export type ProviderRuntime = z.infer<typeof providerRuntimeSchema>;

const windows = process.platform === 'win32';

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Search PATH the way a shell-free spawn does on this platform, except that the working directory is
 * never searched: a worktree cannot plant a provider executable. On Windows a name without an
 * extension matches `.com` and `.exe` only, so npm `.cmd` shims are not found.
 */
export function findExecutable(name: string): string | null {
  const candidates = windows ? [...(extname(name) ? [name] : []), `${name}.com`, `${name}.exe`] : [name];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const path = resolve(directory, candidate);
      if (executableFile(path)) return path;
    }
  }
  return null;
}

/** On Windows, a script shim on PATH explains why the native program was not found. */
function shimProblem(name: string, variable: string): string {
  if (windows)
    for (const directory of (process.env.PATH ?? '').split(delimiter))
      for (const extension of ['.cmd', '.bat', '.ps1']) {
        const shim = directory ? join(directory, `${name}${extension}`) : '';
        if (shim && existsSync(shim))
          return `Only the script shim ${shim} is on PATH; Grampus starts native executables without a shell. Set ${variable} to the native ${name}.exe`;
      }
  return `${name} was not found on PATH; install it or set ${variable}`;
}

function configured(provider: Provider, value: string, variable: string): ProviderExecutable {
  const named = isAbsolute(value) || /[\\/]/.test(value);
  const path = named ? (executableFile(resolve(value)) ? resolve(value) : null) : findExecutable(value);
  return {
    provider,
    command: path ?? value,
    path,
    source: 'environment',
    problem: path ? null : `${variable} names ${value}, which is not an executable file`,
  };
}

/** The `codex` program every Codex connection and `doctor` start. */
export function codexExecutable(): ProviderExecutable {
  const override = process.env.GRAMPUS_CODEX_COMMAND;
  if (override) return configured('codex', override, 'GRAMPUS_CODEX_COMMAND');
  const path = findExecutable('codex');
  return {
    provider: 'codex',
    command: path ?? 'codex',
    path,
    source: 'path',
    problem: path ? null : shimProblem('codex', 'GRAMPUS_CODEX_COMMAND'),
  };
}

const sdkEntry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
const sdkPackageSchema = z.looseObject({ version: z.string(), claudeCodeVersion: z.string().optional() });

/** The pinned Agent SDK package: its version and the Claude Code version it bundles. */
export function claudeSdk(): { version: string; claudeCodeVersion: string | null } {
  const value: unknown = JSON.parse(readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8'));
  const parsed = sdkPackageSchema.parse(value);
  return { version: parsed.version, claudeCodeVersion: parsed.claudeCodeVersion ?? null };
}

/** The platform packages the SDK looks for, in its own order. */
function bundledCandidates(): string[] {
  const scope = '@anthropic-ai/claude-agent-sdk';
  const file = `claude${windows ? '.exe' : ''}`;
  const { platform, arch } = process;
  const names =
    platform === 'linux' ? [`${scope}-linux-${arch}`, `${scope}-linux-${arch}-musl`] : [`${scope}-${platform}-${arch}`];
  return names.map(name => `${name}/${file}`);
}

/**
 * The Claude program every Claude query and `doctor` start: `GRAMPUS_CLAUDE_COMMAND`, or the native
 * executable from the SDK's platform package, resolved from the SDK's own location as the SDK does.
 */
export function claudeExecutable(): ProviderExecutable {
  const override = process.env.GRAMPUS_CLAUDE_COMMAND;
  if (override) return configured('claude', override, 'GRAMPUS_CLAUDE_COMMAND');
  const require = createRequire(sdkEntry);
  for (const candidate of bundledCandidates()) {
    try {
      const path = require.resolve(candidate);
      if (executableFile(path)) return { provider: 'claude', command: path, path, source: 'bundled', problem: null };
    } catch {
      /* Not installed for this platform; try the next candidate. */
    }
  }
  return {
    provider: 'claude',
    command: 'claude',
    path: null,
    source: 'bundled',
    problem: `The Agent SDK has no bundled Claude executable for ${process.platform}-${process.arch}; reinstall dependencies or set GRAMPUS_CLAUDE_COMMAND`,
  };
}

/** The resolved executable of a provider. */
export function providerExecutable(provider: Provider): ProviderExecutable {
  return provider === 'codex' ? codexExecutable() : claudeExecutable();
}

/** The first version-like token of `--version` output, so `codex-cli 0.1.0` and `0.1.0 (Claude Code)` compare. */
export function normaliseVersion(output: string): string | null {
  const line = output.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(line)?.[0] ?? (line || null);
}

// Version probes are cached per file identity, so a process asks each executable once.
const versions = new Map<string, string | null>();

/** The version an executable reports with `--version`, or null when it cannot be run. Synchronous and cached. */
export function executableVersion(path: string): string | null {
  let key: string;
  try {
    const stat = statSync(path);
    key = `${path}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = versions.get(key);
  if (cached !== undefined) return cached;
  const version = probeVersion(path);
  versions.set(key, version);
  return version;
}

function probeVersion(path: string): string | null {
  try {
    return normaliseVersion(
      execFileSync(path, ['--version'], {
        encoding: 'utf8',
        timeout: processLimits.commandTimeoutMs,
        maxBuffer: processLimits.commandOutputBytes,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Never hold the caller's working directory, which may be a worktree about to be removed.
        cwd: tmpdir(),
      }),
    );
  } catch {
    return null;
  }
}

/** The provider program a session created now would run. */
export function providerRuntime(provider: Provider): ProviderRuntime {
  const executable = providerExecutable(provider);
  return {
    executable: executable.path,
    source: executable.source,
    version: executable.path ? executableVersion(executable.path) : null,
    sdkVersion: provider === 'claude' ? claudeSdk().version : null,
  };
}
