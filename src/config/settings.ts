// Operational settings: values an installation may tune without changing what an approval, a piece of
// evidence or a recovery comparison means. Built-in defaults apply when `<data directory>/config.json`
// is absent; the file may override any subset and is validated strictly. Fixed bounds are in limits.ts.
//
// Each process installs its settings once at startup (`useSettings`): the CLI loads the file, and the
// workers it starts receive the already loaded values in their request rather than reading the file
// again. Library code reads `currentSettings()`, which falls back to the built-in defaults, so tests and
// probes are unaffected by a developer's own config.json unless they inject settings themselves.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkflowPolicy } from '../domain/workflow-policy.js';
import {
  qualityPassDefinitionSchema,
  qualitySettingsProblems,
  type QualityPassDefinition,
} from '../domain/quality-passes.js';
import { commandLimits, qualityLimits, workflowPolicyBounds } from './limits.js';
import { defaultDashboardPort } from './runtime.js';

export interface Settings {
  /** Loopback port of the dashboard server; `--port` still overrides it for one launch. */
  dashboardPort: number;
  /** How often Claude usage is sampled during a turn; the final result always replaces the samples. */
  usagePollIntervalMs: number;
  /** Check, preparation and acceptance timeout written into new plans that omit `timeoutMs`. */
  defaultCheckTimeoutMs: number;
  /** Workflow policy for new plans that omit it, or fields of it; approved plans keep their own copy. */
  defaultWorkflowPolicy: WorkflowPolicy;
  /** Custom quality pass definitions a plan may select by id, in addition to the built-ins. */
  qualityPasses: readonly QualityPassDefinition[];
  /** Quality pass ids selected for new plans that omit `quality`; approved plans keep their own copy. */
  defaultQualityPasses: readonly string[];
  /** Planned: guided tasks that may run at once, each in its own worktree. Not used yet. */
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
    defaultCheckTimeoutMs: 120_000,
    defaultWorkflowPolicy: { mode: 'automatic', repairRounds: 2, maxSessionTurns: 6, maxContextTokens: 120_000 },
    qualityPasses: [],
    defaultQualityPasses: ['simplification'],
    maxConcurrentTasks: 2,
    stallWarningMs: 600_000,
    healthCheckIntervalMs: 600_000,
  };
}

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const bounded = (range: { min: number; max: number }) => integer(range.min, range.max);
const overridesSchema = z
  .strictObject({
    dashboardPort: integer(1, 65_535).optional(),
    usagePollIntervalMs: integer(1000, 600_000).optional(),
    defaultCheckTimeoutMs: integer(commandLimits.minTimeoutMs, commandLimits.maxTimeoutMs).optional(),
    defaultWorkflowPolicy: z
      .strictObject({
        mode: z.enum(['automatic', 'supervised']).optional(),
        repairRounds: bounded(workflowPolicyBounds.repairRounds).optional(),
        maxSessionTurns: bounded(workflowPolicyBounds.maxSessionTurns).optional(),
        maxContextTokens: bounded(workflowPolicyBounds.maxContextTokens).optional(),
      })
      .optional(),
    qualityPasses: z.array(qualityPassDefinitionSchema).max(qualityLimits.customPasses).optional(),
    defaultQualityPasses: z.array(z.string()).max(qualityLimits.passes).optional(),
    maxConcurrentTasks: integer(1, 16).optional(),
    stallWarningMs: integer(1000, 86_400_000).optional(),
    healthCheckIntervalMs: integer(1000, 86_400_000).optional(),
  })
  .superRefine((value, context) => {
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
 * them over the built-in defaults. Unknown keys and out-of-range values are refused, never ignored.
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

/** Read `<dataDirectory>/config.json` if it exists. The directory is never created or written. */
export function loadSettings(dataDirectory: string): Settings {
  const path = join(dataDirectory, settingsFileName);
  if (!existsSync(path)) return defaultSettings();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid settings in ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return parseSettings(value, path);
}

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
