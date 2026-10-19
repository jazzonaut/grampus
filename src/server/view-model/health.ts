// Owns the header health card: the stored integration health (`health/health.ts`) as one overall word
// (ready, degraded, blocked or unknown) with the reason naming the affected integration and capability.
// Health is informational: nothing here gates a task.
import type { HealthView } from '../../health/health.js';
import type { CapabilityName, HealthStatus, IntegrationId } from '../../health/health-record.js';
import type { HealthSummaryV1, OverallHealth } from '../api-types.js';

const statusLabels: Readonly<Record<HealthStatus, string>> = {
  healthy: 'Healthy',
  failed: 'Failed',
  untested: 'Not tested',
  not_configured: 'Not configured',
  auth_unavailable: 'Sign-in needed',
  temporarily_unavailable: 'Temporarily unavailable',
};

const integrationLabels: Readonly<Record<IntegrationId, string>> = {
  codex: 'Codex',
  claude: 'Claude',
  git: 'Git',
  orca: 'Orca',
  node: 'Node',
  powershell: 'Windows PowerShell',
};

const capabilityLabels: Readonly<Record<CapabilityName, string>> = {
  executable: 'Executable',
  version: 'Version',
  auth: 'Sign-in',
  handshake: 'Handshake',
  mcp: 'MCP',
  inference: 'Inference',
  sqlite: 'SQLite',
  supervisor: 'Native supervisor',
};

/** Statuses of a required integration that stop tasks from starting or finishing. */
const blocking: ReadonlySet<HealthStatus> = new Set<HealthStatus>(['failed', 'auth_unavailable', 'not_configured']);

const labels: Readonly<Record<OverallHealth, string>> = {
  ready: 'Integrations healthy',
  degraded: 'Integrations need attention',
  blocked: 'Integrations need attention',
  unknown: 'Integrations not checked yet',
};

function overall(view: HealthView): { overall: OverallHealth; reason: string } {
  if (view.status === 'unknown')
    return { overall: 'unknown', reason: 'Integrations have not been checked yet; choose Check again.' };
  const required = view.integrations.filter(item => item.required && item.status !== 'healthy');
  const worst = required.find(item => blocking.has(item.status)) ?? required[0];
  if (worst) {
    const capability = worst.capabilities.find(item => item.status === worst.status);
    const what = capability
      ? `${integrationLabels[worst.id]} ${capabilityLabels[capability.name].toLowerCase()}`
      : integrationLabels[worst.id];
    return {
      overall: blocking.has(worst.status) ? 'blocked' : 'degraded',
      reason: `${what}: ${statusLabels[worst.status].toLowerCase()}${capability?.detail ? ` (${capability.detail})` : ''}.`,
    };
  }
  if (view.warnings[0]) return { overall: 'degraded', reason: view.warnings[0] };
  return {
    overall: 'ready',
    reason: view.stale
      ? 'Every required integration was healthy at the last check, which is due to be repeated.'
      : 'Every required integration was healthy at the last check. Inference is never tested by health checks.',
  };
}

/** The health card from the stored health view. Executable paths are left out. */
export function healthSummary(view: HealthView): HealthSummaryV1 {
  const { overall: status, reason } = overall(view);
  return {
    overall: status,
    label: labels[status],
    reason,
    checkedAt: view.checkedAt,
    stale: view.stale,
    warnings: [...view.warnings],
    integrations: view.integrations.map(item => ({
      id: item.id,
      label: integrationLabels[item.id],
      required: item.required,
      status: item.status,
      statusLabel: statusLabels[item.status],
      version: item.version,
      sdkVersion: item.sdkVersion,
      capabilities: item.capabilities.map(capability => ({
        name: capability.name,
        label: capabilityLabels[capability.name],
        status: capability.status,
        statusLabel: statusLabels[capability.status],
        detail: ['healthy', 'untested'].includes(capability.status) ? '' : capability.detail,
      })),
    })),
  };
}
