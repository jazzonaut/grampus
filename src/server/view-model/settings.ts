// Owns the Settings screen: one form over `config.json` with a field per operational setting, holding the
// value stored in the file (empty when the key is absent, so the built-in default applies), and whether
// a restart is needed to apply what is saved. Validation stays in config/settings.ts; the field ranges
// shown here are hints read from the same table the schema enforces.
import { workflowPolicyBounds } from '../../config/limits.js';
import {
  defaultSettings,
  settingRanges,
  type IntegerSetting,
  type Settings,
  type SettingsFile,
} from '../../config/settings.js';
import type { FormField, JsonValue, SettingsV1 } from '../api-types.js';
import { action, field, option } from './actions.js';

/** What the Settings screen is drawn from. */
export interface SettingsFacts {
  /** The data directory's settings file, or null when this dashboard has none to edit. */
  file: SettingsFile | null;
  /** The settings this process started with. */
  active: Settings;
}

const integerSettings: readonly (IntegerSpec & { key: IntegerSetting })[] = [
  {
    key: 'observabilityIntervalMs',
    label: 'Observability refresh interval (ms)',
    meaning: 'Interval between display-only journal reads while an execution graph is visible. No agent calls.',
  },
  {
    key: 'dashboardStartupMs',
    label: 'Background dashboard startup deadline (ms)',
    meaning: 'How long a launcher waits for an authenticated dashboard. An uncertain process is never restarted.',
  },
  {
    key: 'dashboardProbeMs',
    label: 'Dashboard discovery deadline (ms)',
    meaning: 'Deadline for a local authenticated discovery or shutdown request.',
  },
  {
    key: 'dashboardPollMs',
    label: 'Dashboard startup observation interval (ms)',
    meaning: 'Interval between observations while a background dashboard starts.',
  },
  {
    key: 'orcaSyncIntervalMs',
    label: 'Orca card refresh interval (ms)',
    meaning:
      'Interval between journal observations for Orca worktree cards while the dashboard is open. No agent calls.',
  },
  {
    key: 'liveChangesIntervalMs',
    label: 'Live changes refresh interval (ms)',
    meaning: 'Interval between display-only workspace observations while the task is visible. No agent calls.',
  },
  {
    key: 'maxConcurrentTasks',
    label: 'Tasks that may run at once',
    meaning:
      'Guided tasks that may own a runner at once, each in its own worktree. Starting another is refused, never queued.',
  },
  {
    key: 'defaultCheckTimeoutMs',
    label: 'Check timeout for new plans (ms)',
    meaning: 'Written into new plans for validation and acceptance commands that set no timeout.',
  },
  {
    key: 'defaultPreparationTimeoutMs',
    label: 'Preparation timeout for new plans (ms)',
    meaning:
      'Written into new plans for preparation commands that set no timeout. Preparation restores dependencies in a fresh worktree without caches.',
  },
  {
    key: 'stallWarningMs',
    label: 'Stall warning after (ms)',
    meaning: 'Silence after which a running turn or check is shown as possibly stalled. Nothing is stopped.',
  },
  {
    key: 'healthCheckIntervalMs',
    label: 'Health check age (ms)',
    meaning: 'Age after which integration health is checked again when the dashboard starts and before a guided run.',
  },
  {
    key: 'dashboardPort',
    label: 'Dashboard port',
    meaning: 'Loopback port of the dashboard. `--port` still overrides it for one launch.',
  },
  {
    key: 'usagePollIntervalMs',
    label: 'Claude usage sampling (ms)',
    meaning: 'How often Claude usage is sampled during a turn. The final result always replaces the samples.',
  },
  {
    key: 'outputFlushIntervalMs',
    label: 'Output journaling interval (ms)',
    meaning:
      'Longest time streamed agent output is held in memory before it is journaled. Must be shorter than the stall warning.',
  },
  {
    key: 'outputFlushBytes',
    label: 'Output journaling size (bytes)',
    meaning: 'Buffered streamed output that is journaled at once without waiting for the interval.',
  },
];

const policySettings: readonly (IntegerSpec & { key: keyof typeof workflowPolicyBounds })[] = [
  {
    key: 'readinessRounds',
    label: 'Readiness repairs for new plans',
    meaning:
      'Separate automatic allowance per slice for explicitly approved formatting, lint and type checks. Retries never replenish it.',
  },
  {
    key: 'maxTaskTurns',
    label: 'Task-wide turns for new plans',
    meaning: 'Requested agent turns across linked planning, all versions and all slices.',
  },
  {
    key: 'maxTaskTokens',
    label: 'Task-wide token threshold for new plans',
    meaning:
      'Zero disables the token gate. When enabled, incomplete usage stops further turns; an active turn may exceed the threshold.',
  },
  {
    key: 'repairRounds',
    label: 'Repair rounds for new plans',
    meaning:
      'Shared automatic repair rounds per slice across behavioural validation, review and acceptance. Readiness is separate.',
  },
  {
    key: 'maxSessionTurns',
    label: 'Turns per agent conversation',
    meaning: 'Turns before a fresh provider conversation.',
  },
  {
    key: 'maxContextTokens',
    label: 'Context tokens per agent conversation',
    meaning: 'Observed input tokens before a fresh provider conversation.',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored value at `key`, as a field starts from it; null when absent. */
function storedValue(stored: unknown, key: string): JsonValue {
  if (!isRecord(stored)) return null;
  // The file is JSON, so whatever it holds is a JSON value; the schema judges it on save.
  return (stored[key] ?? null) as JsonValue;
}

/** What an integer field shows: its key (also the field name), label and meaning. */
interface IntegerSpec {
  key: string;
  label: string;
  meaning: string;
}

function integerField(
  { key, label, meaning }: IntegerSpec,
  target: string,
  range: { min: number; max: number },
  fallback: number,
  value: JsonValue,
): FormField {
  return field({
    name: key,
    label,
    input: 'number',
    target,
    value,
    min: range.min,
    max: range.max,
    step: 1,
    placeholder: `Default ${fallback}`,
    help: `${meaning} Allowed ${range.min} to ${range.max}; empty uses the default (${fallback}).`,
  });
}

function settingsFields(stored: unknown): FormField[] {
  const defaults = defaultSettings();
  const policy = storedValue(stored, 'defaultWorkflowPolicy');
  return [
    ...integerSettings.map(spec =>
      integerField(
        spec,
        `/overrides/${spec.key}`,
        settingRanges[spec.key],
        defaults[spec.key],
        storedValue(stored, spec.key),
      ),
    ),
    field({
      name: 'workflowMode',
      label: 'Workflow mode for new plans',
      input: 'select',
      target: '/overrides/defaultWorkflowPolicy/mode',
      value: storedValue(policy, 'mode'),
      options: [
        option(null, `Default (${defaults.defaultWorkflowPolicy.mode})`),
        option('automatic', 'Automatic', 'runs to a verified commit'),
        option('supervised', 'Supervised', 'stops at file authorization and quality assessment'),
      ],
    }),
    ...policySettings.map(spec =>
      integerField(
        spec,
        `/overrides/defaultWorkflowPolicy/${spec.key}`,
        workflowPolicyBounds[spec.key],
        defaults.defaultWorkflowPolicy[spec.key],
        storedValue(policy, spec.key),
      ),
    ),
    field({
      name: 'modelProfiles',
      label: 'Model profiles',
      input: 'json',
      target: '/overrides/modelProfiles',
      value: storedValue(stored, 'modelProfiles'),
      help: 'Use the Model profiles screen to edit fixed role assignments. Approved plans retain their own snapshots.',
    }),
    field({
      name: 'defaultQualityPasses',
      label: 'Quality passes for new plans',
      input: 'json',
      target: '/overrides/defaultQualityPasses',
      value: storedValue(stored, 'defaultQualityPasses'),
      placeholder: `Default ${JSON.stringify(defaults.defaultQualityPasses)}`,
      help: 'A JSON list of pass ids: the built-ins `simplification`, `naming`, `refactor` and `documentation`, or a custom id below. `[]` selects none; empty uses the default.',
    }),
    field({
      name: 'qualityPasses',
      label: 'Custom quality passes',
      input: 'json',
      target: '/overrides/qualityPasses',
      value: storedValue(stored, 'qualityPasses'),
      placeholder: '[{ "id": "error-handling", "title": "Error handling", "kind": "lens", "instructions": "…" }]',
      help: 'A JSON list of definitions with `id`, `title`, `kind` (`lens` or `edit`) and `instructions`. Approved plans keep the definitions they selected.',
    }),
  ];
}

/** The Settings screen of one dashboard. */
export function settingsView({ file, active }: SettingsFacts): SettingsV1 {
  const expected = file?.revision ?? null;
  return {
    apiVersion: 1,
    file: file?.path ?? null,
    restartRequired: file?.settings ? JSON.stringify(file.settings) !== JSON.stringify(active) : false,
    problem: file?.problem ?? null,
    save: action({
      id: 'save-settings',
      label: 'Save settings',
      kind: 'primary',
      description: 'Writes config.json. Grampus reads it when it starts, so restart the dashboard to apply it.',
      path: '/api/settings',
      expected,
      body: { expected: expected ?? '', overrides: {} },
      form: {
        kind: 'settings',
        intro:
          'Leave a field empty to keep the built-in default. Saved values apply when Grampus next starts; plans already approved keep their own values.',
        fields: settingsFields(file?.stored),
        submitLabel: 'Save settings',
      },
      disabledReason: file ? null : 'This dashboard was started without a settings file, so it cannot save one.',
    }),
  };
}
