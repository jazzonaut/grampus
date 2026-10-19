// Operational settings: values an installation may tune without changing what an approval, a piece of
// evidence or a recovery comparison means. Built-in defaults apply when `<data directory>/config.json`
// is absent; the file may override any subset and is validated strictly. Fixed bounds are in limits.ts.
// The dashboard's Settings screen is the only writer of the file (`saveSettingsFile`); the change applies
// when Grampus next starts.
//
// Each process installs its settings once at startup (`useSettings`): the CLI loads the file, and the
// workers it starts receive the already loaded values in their request rather than reading the file
// again. Library code reads `currentSettings()`, which falls back to the built-in defaults, so tests and
// probes are unaffected by a developer's own config.json unless they inject settings themselves.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkflowPolicy } from '../domain/workflow-policy.js';
import {
  qualityPassDefinitionSchema,
  qualitySettingsProblems,
  type QualityPassDefinition,
} from '../domain/quality-passes.js';
import { StaleStateError } from '../persistence/errors.js';
import { KiB, MiB, commandLimits, qualityLimits, workflowPolicyBounds } from './limits.js';
import { defaultDashboardPort } from './runtime.js';

/**
 * The effective operational settings of one process. None of them is bound into an approval: values
 * that a plan depends on (default timeouts, workflow policy, quality passes) are copied into the plan
 * when it is normalised.
 */
export interface Settings {
  /** Loopback port of the dashboard server; `--port` still overrides it for one launch. */
  dashboardPort: number;
  /** How often Claude usage is sampled during a turn; the final result always replaces the samples. */
  usagePollIntervalMs: number;
  /** Minimum interval between display-only workspace observations in the dashboard. */
  liveChangesIntervalMs: number;
  /**
   * Longest time streamed provider output is held in memory before it is journaled as one
   * `output.delta` event. Display-only text written in this interval is lost if the process dies.
   */
  outputFlushIntervalMs: number;
  /** Buffered streamed output size, in UTF-8 bytes, that is journaled at once without waiting. */
  outputFlushBytes: number;
  /**
   * Preparation timeout written into new plans that omit `timeoutMs`. Longer than the check default
   * because preparation restores dependencies in a fresh worktree without caches.
   */
  defaultPreparationTimeoutMs: number;
  /** Validation and acceptance timeout written into new plans that omit `timeoutMs`. */
  defaultCheckTimeoutMs: number;
  /** Workflow policy for new plans that omit it, or fields of it; approved plans keep their own copy. */
  defaultWorkflowPolicy: WorkflowPolicy;
  /** Custom quality pass definitions a plan may select by id, in addition to the built-ins. */
  qualityPasses: readonly QualityPassDefinition[];
  /** Quality pass ids selected for new plans that omit `quality`; approved plans keep their own copy. */
  defaultQualityPasses: readonly string[];
  /**
   * Guided tasks that may own a runner at once, each in its own worktree. A claim that would exceed it
   * is refused, never queued. Also the bound on simultaneous guided agent turns, one per task.
   */
  maxConcurrentTasks: number;
  /** Silence after which a running turn or check of a guided task is shown as possibly stalled; nothing is stopped. */
  stallWarningMs: number;
  /** Age after which the stored integration health is checked again at dashboard start or before a guided run. */
  healthCheckIntervalMs: number;
}

/** File name of the optional settings file inside the data directory. */
export const settingsFileName = 'config.json';

/** Built-in defaults: exactly the behaviour without a settings file. */
export function defaultSettings(): Settings {
  return {
    dashboardPort: defaultDashboardPort,
    usagePollIntervalMs: 15_000,
    liveChangesIntervalMs: 5000,
    outputFlushIntervalMs: 1000,
    outputFlushBytes: 8 * KiB,
    defaultPreparationTimeoutMs: 600_000,
    defaultCheckTimeoutMs: 300_000,
    defaultWorkflowPolicy: {
      mode: 'automatic',
      repairRounds: 3,
      maxSessionTurns: 6,
      maxContextTokens: 120_000,
      maxTaskTurns: 20,
      maxTaskTokens: 0,
    },
    qualityPasses: [],
    defaultQualityPasses: ['simplification'],
    maxConcurrentTasks: 2,
    stallWarningMs: 600_000,
    healthCheckIntervalMs: 600_000,
  };
}

/** Allowed range of each top-level integer setting; the schema enforces it and the Settings screen shows it. */
export const settingRanges = {
  dashboardPort: { min: 1, max: 65_535 },
  usagePollIntervalMs: { min: 1000, max: 600_000 },
  liveChangesIntervalMs: { min: 1000, max: 600_000 },
  outputFlushIntervalMs: { min: 100, max: 60_000 },
  outputFlushBytes: { min: 1 * KiB, max: 1 * MiB },
  defaultPreparationTimeoutMs: { min: commandLimits.minTimeoutMs, max: commandLimits.maxTimeoutMs },
  defaultCheckTimeoutMs: { min: commandLimits.minTimeoutMs, max: commandLimits.maxTimeoutMs },
  maxConcurrentTasks: { min: 1, max: 4 },
  stallWarningMs: { min: 1000, max: 86_400_000 },
  healthCheckIntervalMs: { min: 1000, max: 86_400_000 },
} as const;

/** A top-level setting whose value is an integer. */
export type IntegerSetting = keyof typeof settingRanges;

const bounded = (range: { min: number; max: number }) => z.number().int().min(range.min).max(range.max);
const overridesSchema = z
  .strictObject({
    dashboardPort: bounded(settingRanges.dashboardPort).optional(),
    usagePollIntervalMs: bounded(settingRanges.usagePollIntervalMs).optional(),
    liveChangesIntervalMs: bounded(settingRanges.liveChangesIntervalMs).optional(),
    outputFlushIntervalMs: bounded(settingRanges.outputFlushIntervalMs).optional(),
    outputFlushBytes: bounded(settingRanges.outputFlushBytes).optional(),
    defaultPreparationTimeoutMs: bounded(settingRanges.defaultPreparationTimeoutMs).optional(),
    defaultCheckTimeoutMs: bounded(settingRanges.defaultCheckTimeoutMs).optional(),
    defaultWorkflowPolicy: z
      .strictObject({
        mode: z.enum(['automatic', 'supervised']).optional(),
        repairRounds: bounded(workflowPolicyBounds.repairRounds).optional(),
        maxSessionTurns: bounded(workflowPolicyBounds.maxSessionTurns).optional(),
        maxContextTokens: bounded(workflowPolicyBounds.maxContextTokens).optional(),
        maxTaskTurns: bounded(workflowPolicyBounds.maxTaskTurns).optional(),
        maxTaskTokens: bounded(workflowPolicyBounds.maxTaskTokens).optional(),
      })
      .optional(),
    qualityPasses: z.array(qualityPassDefinitionSchema).max(qualityLimits.customPasses).optional(),
    defaultQualityPasses: z.array(z.string()).max(qualityLimits.passes).optional(),
    maxConcurrentTasks: bounded(settingRanges.maxConcurrentTasks).optional(),
    stallWarningMs: bounded(settingRanges.stallWarningMs).optional(),
    healthCheckIntervalMs: bounded(settingRanges.healthCheckIntervalMs).optional(),
  })
  .superRefine((value, context) => {
    // Buffered output is journaled at most this often, so a stall threshold at or below it would warn
    // about a turn that is streaming normally. Defaults count when only one of the two is set.
    const defaults = defaultSettings();
    const flush = value.outputFlushIntervalMs ?? defaults.outputFlushIntervalMs,
      stall = value.stallWarningMs ?? defaults.stallWarningMs;
    if (flush >= stall)
      context.addIssue({
        code: 'custom',
        path: ['outputFlushIntervalMs'],
        message: `must be shorter than stallWarningMs (${flush} is not below ${stall})`,
      });
    for (const problem of qualitySettingsProblems(
      value.qualityPasses ?? [],
      value.defaultQualityPasses ?? defaultSettings().defaultQualityPasses,
    ))
      context.addIssue({ code: 'custom', path: problem.path, message: problem.message });
  });

function describeIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map(key => `unknown key "${at ? `${at}.` : ''}${key}"`).join('; ');
  return `${at ? `"${at}"` : 'the settings'}: ${issue.message}`;
}

/**
 * Validate settings overrides from `source` (a file path or a description used in errors) and merge
 * them over the built-in defaults. Unknown keys and out-of-range values are refused, never ignored:
 * throws one error listing the problems found.
 */
export function parseSettings(value: unknown, source: string): Settings {
  const parsed = overridesSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Invalid settings in ${source}: ${parsed.error.issues.map(describeIssue).join('; ')}`);
  const defaults = defaultSettings();
  const { defaultWorkflowPolicy, ...rest } = parsed.data;
  const merged: Settings = { ...defaults, defaultWorkflowPolicy: { ...defaults.defaultWorkflowPolicy } };
  for (const [key, item] of Object.entries(rest)) if (item !== undefined) Object.assign(merged, { [key]: item });
  for (const [key, item] of Object.entries(defaultWorkflowPolicy ?? {}))
    if (item !== undefined) Object.assign(merged.defaultWorkflowPolicy, { [key]: item });
  return merged;
}

/** The settings file of a data directory as it is stored now. */
export interface SettingsFile {
  path: string;
  /**
   * `absent`, or a SHA-256 digest of the file's bytes. A save names the revision it was edited from, so
   * a change made meanwhile (by hand or in another tab) is never overwritten unseen.
   */
  revision: string;
  /** The parsed JSON, or undefined when the file is absent or is not JSON. */
  stored: unknown;
  /** The settings the file gives (the defaults when it is absent), or null when it is invalid. */
  settings: Settings | null;
  /** Why the file is refused, naming the file and each offending key; null when it is absent or valid. */
  problem: string | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Read `<dataDirectory>/config.json` without refusing an invalid file. The directory is never created. */
export function readSettingsFile(dataDirectory: string): SettingsFile {
  const path = join(dataDirectory, settingsFileName);
  if (!existsSync(path))
    return { path, revision: 'absent', stored: undefined, settings: defaultSettings(), problem: null };
  const bytes = readFileSync(path);
  const revision = digest(bytes);
  let stored: unknown;
  try {
    stored = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      path,
      revision,
      stored: undefined,
      settings: null,
      problem: `Invalid settings in ${path}: ${errorText(error)}`,
    };
  }
  try {
    return { path, revision, stored, settings: parseSettings(stored, path), problem: null };
  } catch (error) {
    return { path, revision, stored, settings: null, problem: errorText(error) };
  }
}

/**
 * Read `<dataDirectory>/config.json` if it exists. The directory is never created or written. Throws
 * when the file is not valid JSON or fails {@link parseSettings}.
 */
export function loadSettings(dataDirectory: string): Settings {
  const file = readSettingsFile(dataDirectory);
  if (!file.settings) throw new Error(file.problem ?? `Invalid settings in ${file.path}`);
  return file.settings;
}

/**
 * Validate `overrides` and store exactly them as `<dataDirectory>/config.json`, provided the file is
 * still at revision `expected` (otherwise {@link StaleStateError}). Omitted keys keep following the
 * built-in defaults, so a later change of a default still applies. The text is written to a temporary
 * file and renamed over the old one, so a reader never sees half a file. Nothing changes in a running
 * process: the new values apply when Grampus next starts.
 */
export function saveSettingsFile(dataDirectory: string, overrides: unknown, expected: string): void {
  parseSettings(overrides, 'the settings form');
  const { path, revision } = readSettingsFile(dataDirectory);
  if (revision !== expected)
    throw new StaleStateError(`${path} changed since the settings were shown; check the current values and save again`);
  mkdirSync(dataDirectory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(overrides, null, 2)}
`,
    );
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Installed settings are frozen so library code that reads them can never change them for the process.
const freeze = (settings: Settings): Settings =>
  Object.freeze({
    ...settings,
    defaultWorkflowPolicy: Object.freeze({ ...settings.defaultWorkflowPolicy }),
    qualityPasses: Object.freeze(settings.qualityPasses.map(pass => Object.freeze({ ...pass }))),
    defaultQualityPasses: Object.freeze([...settings.defaultQualityPasses]),
  });
let active: Settings | null = null;

/** Install the settings for this process. Entry points call this once at startup; tests may inject values. */
export function useSettings(settings: Settings): void {
  active = freeze(settings);
}

/** The settings installed for this process, or the built-in defaults if none were installed. */
export function currentSettings(): Settings {
  active ??= freeze(defaultSettings());
  return active;
}
