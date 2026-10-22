// Operational settings: values an installation may tune without changing what a recorded spec, check or
// review means. Built-in defaults apply when `<data directory>/config.json` is absent; the file may
// override any subset and is validated strictly. Fixed bounds are in limits.ts.
//
// Each entry point installs its settings once (`useSettings`). Library code reads `currentSettings()`,
// which falls back to the built-in defaults, so tests are unaffected by a developer's own config.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { recipeSchema, standardRecipe, type Recipe } from '../domain/recipe.js';
import { defaultModelPrices, type ModelPrice } from '../measure/cost.js';
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
  /** The Claude Code CLI, asked for its model aliases and effort levels by the recipe editor. */
  claudeCommand: readonly string[];
  /** The Codex CLI, asked for its model catalog by the recipe editor. */
  codexCommand: readonly string[];
  /** API list prices per model for estimated cost, in US dollars per million tokens. config.json entries replace single models. */
  modelPrices: Readonly<Record<string, ModelPrice>>;
  /** How many entries of a comparison run at once; the rest wait for a free place. */
  comparisonConcurrency: number;
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
    claudeCommand: ['claude'],
    codexCommand: ['codex'],
    modelPrices: defaultModelPrices,
    comparisonConcurrency: 2,
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
    claudeCommand: z.array(z.string().min(1)).min(1),
    codexCommand: z.array(z.string().min(1)).min(1),
    modelPrices: z.record(
      z.string().min(1),
      z
        .object({
          input: z.number().nonnegative(),
          cachedInput: z.number().nonnegative(),
          cacheWrite: z.number().nonnegative(),
          output: z.number().nonnegative(),
        })
        .strict(),
    ),
    comparisonConcurrency: z.number().int().positive(),
  })
  .strict()
  .partial();

/** Defaults overridden by `<dataDir>/config.json` when it exists. Invalid files are refused, not ignored. */
export function loadSettings(dataDir: string): Settings {
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return defaultSettings();
  const defaults = defaultSettings();
  const overrides = validated(JSON.parse(readFileSync(path, 'utf8')), path);
  // Prices are merged per model, so adding one model keeps the built-in table.
  return { ...defaults, ...overrides, modelPrices: { ...defaults.modelPrices, ...overrides.modelPrices } };
}

/** The overrides a config file sets, after the same checks `loadSettings` applies. */
function validated(raw: unknown, path: string): Partial<Settings> {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid settings in ${path}: ${parsed.error.message}`);
  const names = [standardRecipe.name, ...(parsed.data.recipes ?? []).map(recipe => recipe.name)];
  if (new Set(names).size !== names.length)
    throw new Error(`Recipe names in ${path} must be unique and not "standard".`);
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
}

/**
 * Replace the saved recipes in `config.json`, keeping every other setting as written. The file is
 * validated before it is replaced, and replaced in one rename, so a refused edit leaves it untouched.
 * Running tasks are unaffected: each copied its recipe when it was created.
 */
export function saveRecipes(dataDir: string, recipes: readonly Recipe[]): Settings {
  const path = join(dataDir, 'config.json');
  const current: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = { ...base, recipes };
  validated(next, path);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify(next, null, 2)}
`,
  );
  renameSync(temporary, path);
  return loadSettings(dataDir);
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
