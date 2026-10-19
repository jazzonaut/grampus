// Owns stored integration health: running a check and keeping its latest result in the journal, deciding
// when that result is stale, the compact view the dashboard shows, and the provider version change
// warning. Health is informational: a failed or changed integration never blocks a task by itself;
// the provider adapters still refuse what they cannot use when a turn starts.
import { createHash } from 'node:crypto';
import type { Store } from '../persistence/store.js';
import type { Session } from '../persistence/records.js';
import { currentSettings } from '../config/settings.js';
import { healthLimits } from '../config/limits.js';
import type { Provider } from '../providers/types.js';
import type { Capability, HealthReport, HealthStatus, IntegrationHealth } from './health-record.js';

/** Runs every integration check once and returns the complete result. `doctor` is the real one. */
export type HealthCheck = () => Promise<HealthReport>;

// Worst first. `untested` is not a problem: it only says what a check deliberately did not exercise.
const severity: readonly HealthStatus[] = [
  'failed',
  'auth_unavailable',
  'temporarily_unavailable',
  'not_configured',
  'healthy',
  'untested',
];

/** An integration's status: the worst tested capability, or `untested` when nothing was exercised. */
export function integrationStatus(capabilities: readonly Capability[]): HealthStatus {
  const tested = capabilities.filter(capability => capability.status !== 'untested');
  if (!tested.length) return 'untested';
  return tested.reduce<HealthStatus>(
    (worst, capability) => (severity.indexOf(capability.status) < severity.indexOf(worst) ? capability.status : worst),
    'healthy',
  );
}

/**
 * Detail text safe to journal and display: e-mail addresses, bearer tokens, long secret-like strings and
 * control characters are removed, whitespace is collapsed and the result is bounded.
 */
export function sanitiseDetail(text: string): string {
  const printable = Array.from(text, character => (character < ' ' || character === '\u007f' ? ' ' : character));
  const cleaned = printable
    .join('')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/\bbearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b(token|api[_-]?key|secret|password)(\s*[=:]\s*)\S+/gi, '$1$2<redacted>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > healthLimits.detailCharacters
    ? `${cleaned.slice(0, healthLimits.detailCharacters - 1)}…`
    : cleaned;
}

/** A digest of the integration fingerprints, so reports of an unchanged setup compare equal. */
export function healthFingerprint(integrations: readonly IntegrationHealth[]): string {
  const fingerprints = integrations.map(integration => integration.fingerprint).sort();
  return createHash('sha256')
    .update(JSON.stringify(fingerprints))
    .digest('hex')
    .slice(0, healthLimits.fingerprintCharacters);
}

/** True when there is no stored result, its time cannot be parsed, or it is at least `intervalMs` old. */
export function healthIsStale(report: HealthReport | null, now: number, intervalMs: number): boolean {
  if (!report) return true;
  const checked = Date.parse(report.checkedAt);
  return !Number.isFinite(checked) || now - checked >= intervalMs;
}

/** Run `check` and store its result as the latest health. When `check` rejects, nothing is stored. */
export async function refreshHealth(store: Store, check: HealthCheck): Promise<HealthReport> {
  const report = await check();
  store.transaction(() => store.saveHealth(report));
  return report;
}

/** Run `check` only when the stored result is stale (`healthCheckIntervalMs`); returns the new result or null. */
export async function refreshHealthIfStale(
  store: Store,
  check: HealthCheck,
  now: number = Date.now(),
): Promise<HealthReport | null> {
  if (!healthIsStale(store.health(), now, currentSettings().healthCheckIntervalMs)) return null;
  return refreshHealth(store, check);
}

const providerNames: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' };

/**
 * Warnings for provider programs that differ from the ones that last carried a task to a verified
 * delivery: a version Grampus has not yet delivered with may have changed its protocol or tools. The
 * comparison uses the latest session of each provider on that task. Unknown versions are not compared.
 */
export function versionWarnings(report: HealthReport, delivered: readonly Session[]): string[] {
  const warnings: string[] = [];
  const untested = 'since the last successful delivery; capabilities are untested on this version';
  for (const provider of ['codex', 'claude'] as const) {
    const current = report.integrations.find(integration => integration.id === provider);
    const previous = delivered.findLast(session => session.provider === provider)?.runtime;
    if (!current || !previous) continue;
    const name = providerNames[provider];
    if (previous.version && current.version && previous.version !== current.version)
      warnings.push(`${name} changed from ${previous.version} to ${current.version} ${untested}.`);
    if (previous.sdkVersion && current.sdkVersion && previous.sdkVersion !== current.sdkVersion)
      warnings.push(`${name} Agent SDK changed from ${previous.sdkVersion} to ${current.sdkVersion} ${untested}.`);
  }
  return warnings;
}

/** The stored health with staleness and warnings: `GET /api/health`, and the source of the v1 health summaries. */
export interface HealthView {
  /** `unknown` before the first check; `attention` when a required integration is not healthy or a warning applies. */
  status: 'healthy' | 'attention' | 'unknown';
  checkedAt: string | null;
  /** The stored result is older than `healthCheckIntervalMs`. */
  stale: boolean;
  fingerprint: string | null;
  warnings: string[];
  integrations: IntegrationHealth[];
}

/**
 * The latest stored health with staleness and version change warnings, computed at `now`. A failure to
 * read the last delivery's sessions becomes a warning, so the health view itself still renders.
 */
export function healthView(store: Store, now: number = Date.now()): HealthView {
  const report = store.health();
  const stale = healthIsStale(report, now, currentSettings().healthCheckIntervalMs);
  if (!report) return { status: 'unknown', checkedAt: null, stale, fingerprint: null, warnings: [], integrations: [] };
  let warnings: string[];
  try {
    warnings = versionWarnings(report, store.lastDelivery()?.sessions ?? []);
  } catch (error) {
    warnings = [
      sanitiseDetail(
        `Provider versions could not be compared with the last delivery: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }
  const unhealthy = report.integrations.some(integration => integration.required && integration.status !== 'healthy');
  return {
    status: unhealthy || warnings.length ? 'attention' : 'healthy',
    checkedAt: report.checkedAt,
    stale,
    fingerprint: report.fingerprint,
    warnings,
    integrations: report.integrations,
  };
}

/**
 * One process's health checks: at most one check runs at a time, and concurrent callers share it.
 * The dashboard server uses this for its start-up check and for `GET /api/health?refresh=1`.
 */
export class HealthMonitor {
  private running: Promise<HealthReport> | null = null;

  constructor(
    private readonly store: Store,
    private readonly check: HealthCheck,
    private readonly now: () => number = Date.now,
  ) {}

  /** Run the checks now, or join the check already running. */
  refresh(): Promise<HealthReport> {
    this.running ??= refreshHealth(this.store, this.check).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Run the checks when the stored result is stale; failures are kept out of the caller's way. */
  refreshIfStale(): Promise<void> {
    if (!healthIsStale(this.store.health(), this.now(), currentSettings().healthCheckIntervalMs))
      return Promise.resolve();
    return this.refresh().then(
      () => {},
      () => {},
    );
  }

  /** Resolves once no check is running, so a closing server never leaves health children behind. */
  async settled(): Promise<void> {
    await this.running?.catch(() => {});
  }
}
