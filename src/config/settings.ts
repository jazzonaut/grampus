// Operational settings: values an installation may tune without changing what a recorded spec, check or
// review means. Built-in defaults apply when `<data directory>/config.json` is absent; the file may
// override any subset and is validated strictly. Fixed bounds are in limits.ts.
//
// Each entry point installs its settings once (`useSettings`). Library code reads `currentSettings()`,
// which falls back to the built-in defaults, so tests are unaffected by a developer's own config.json.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { recipeSchema, standardRecipe, type Recipe } from '../domain/recipe.js';
import { specLimits } from './limits.js';

/** The effective operational settings of one process. */
export interface Settings {
  /** The Orca CLI executable and any leading arguments. */
  orcaCommand: readonly string[];
  /** Deadline for one Orca CLI call. `worker-start` waits for setup and agent readiness, so this is generous. */
  orcaCallTimeoutMs: number;
  /** Deadline for one Git query. */
  gitTimeoutMs: number;
  /** How long the driver blocks on Orca's inbox before it looks for local commands again. */
  inboxWaitMs: number;
  /** Minimum interval between liveness checks of a dispatch that has not reported. */
  livenessIntervalMs: number;
  /** How long `grampus wait` blocks before reporting that nothing new needs the user. Below common agent tool limits. */
  waitTimeoutSeconds: number;
  /** How often `grampus wait` and the dashboard reread task logs. */
  waitPollMs: number;
  /** Check timeout when the spec does not set one. */
  defaultCheckTimeoutSeconds: number;
  /** Shell for check commands; null uses Node's platform default (cmd.exe on Windows, /bin/sh elsewhere). */
  checkShell: string | null;
  /** Repository paths treated as tests by the integrity guard. */
  testFilePatterns: readonly string[];
  /** Saved recipes beside the built-in `standard` recipe. */
  recipes: readonly Recipe[];
  /** Folders searched for Claude session transcripts (`<root>/<project>/<session>.jsonl`). */
  claudeProjectRoots: readonly string[];
  /** Folders searched for Codex rollouts (`<root>/YYYY/MM/DD/rollout-...-<session>.jsonl`). */
  codexSessionRoots: readonly string[];
  /** Port `grampus dashboard` listens on when `--port` is not given. */
  dashboardPort: number;
  /** Address the dashboard listens on; null listens on every interface, so other devices on the network can reach it. */
  dashboardHost: string | null;
  /**
   * Host names the dashboard answers to besides localhost, this machine's name and its addresses, such
   * as a VPN name. Requests for any other host are refused, which stops DNS rebinding.
   */
  dashboardAllowedHosts: readonly string[];
}

/** Built-in defaults. */
export function defaultSettings(): Settings {
  return {
    orcaCommand: [process.env.ORCA_CLI_COMMAND ?? 'orca'],
    orcaCallTimeoutMs: 10 * 60_000,
    gitTimeoutMs: 60_000,
    inboxWaitMs: 5_000,
    livenessIntervalMs: 60_000,
    waitTimeoutSeconds: 9 * 60,
    waitPollMs: 2_000,
    defaultCheckTimeoutSeconds: 15 * 60,
    checkShell: null,
    testFilePatterns: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'],
    recipes: [],
    claudeProjectRoots: [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')],
    codexSessionRoots: [join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')],
    dashboardPort: 4545,
    dashboardHost: null,
    dashboardAllowedHosts: [],
  };
}

/** The largest TCP port number. */
const maxPort = 65_535;

const fileSchema = z
  .object({
    orcaCommand: z.array(z.string().min(1)).min(1),
    orcaCallTimeoutMs: z.number().int().positive(),
    gitTimeoutMs: z.number().int().positive(),
    inboxWaitMs: z.number().int().positive(),
    livenessIntervalMs: z.number().int().positive(),
    waitTimeoutSeconds: z.number().int().positive(),
    waitPollMs: z.number().int().positive(),
    defaultCheckTimeoutSeconds: z.number().int().positive().max(specLimits.checkTimeoutSeconds),
    checkShell: z.string().min(1).nullable(),
    testFilePatterns: z.array(z.string().min(1)),
    recipes: z.array(recipeSchema),
    claudeProjectRoots: z.array(z.string().min(1)),
    codexSessionRoots: z.array(z.string().min(1)),
    dashboardPort: z.number().int().min(0).max(maxPort),
    dashboardHost: z.string().min(1).nullable(),
    dashboardAllowedHosts: z.array(z.string().min(1)),
  })
  .strict()
  .partial();

/** Defaults overridden by `<dataDir>/config.json` when it exists. Invalid files are refused, not ignored. */
export function loadSettings(dataDir: string): Settings {
  const path = join(dataDir, 'config.json');
  const defaults = defaultSettings();
  if (!existsSync(path)) return defaults;
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid settings in ${path}: ${parsed.error.message}`);
  const names = [standardRecipe.name, ...(parsed.data.recipes ?? []).map(recipe => recipe.name)];
  if (new Set(names).size !== names.length)
    throw new Error(`Recipe names in ${path} must be unique and not "standard".`);
  const overrides = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
  return { ...defaults, ...overrides };
}

let installed: Settings | null = null;

/** Install this process's settings. Entry points call it once at startup; tests may call it again. */
export function useSettings(settings: Settings): void {
  installed = settings;
}

/** The installed settings, or the built-in defaults. */
export function currentSettings(): Settings {
  return installed ?? defaultSettings();
}

/** Every recipe available for new tasks, built-in first. */
export function availableRecipes(settings: Settings = currentSettings()): Recipe[] {
  return [standardRecipe, ...settings.recipes];
}
