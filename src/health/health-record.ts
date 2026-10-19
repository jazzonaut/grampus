// Pins the stored integration health record: the latest `doctor` result, one row in the journal's
// `health` table, validated on every read like the execution-layer records. The record is a report of
// what was observed, never evidence for a gate: nothing in the workflow reads it to allow progress.
import { z } from 'zod';

/**
 * How one capability or integration looked when it was checked:
 * - `healthy`: checked and working.
 * - `failed`: checked and broken, or missing where it is required.
 * - `untested`: deliberately not exercised by this check (for example inference, or Orca outside an Orca workspace).
 * - `not_configured`: an optional integration that is not installed or configured.
 * - `auth_unavailable`: reachable, but without the subscription login Grampus requires.
 * - `temporarily_unavailable`: a timeout or similar transient failure; checking again may succeed.
 */
export const healthStatusSchema = z.enum([
  'healthy',
  'failed',
  'untested',
  'not_configured',
  'auth_unavailable',
  'temporarily_unavailable',
]);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/** The integrations `doctor` reports on. `powershell` covers the Windows native supervisor. */
export const integrationIdSchema = z.enum(['codex', 'claude', 'git', 'orca', 'node', 'powershell']);
export type IntegrationId = z.infer<typeof integrationIdSchema>;

/** The capability rows an integration may have. */
export const capabilityNameSchema = z.enum([
  'executable',
  'version',
  'auth',
  'handshake',
  'mcp',
  'inference',
  'sqlite',
  'supervisor',
]);
export type CapabilityName = z.infer<typeof capabilityNameSchema>;

export const capabilitySchema = z.object({
  name: capabilityNameSchema,
  status: healthStatusSchema,
  /** Sanitised and bounded: no account identity, credentials or tokens. */
  detail: z.string(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export const integrationHealthSchema = z.object({
  id: integrationIdSchema,
  /** Required integrations make the overall health need attention when they are not healthy. */
  required: z.boolean(),
  /** The worst status of its capability rows, ignoring `untested` ones unless every row is untested. */
  status: healthStatusSchema,
  /** Absolute path of the program that runs, or null when none was found. */
  executable: z.string().nullable(),
  version: z.string().nullable(),
  /** The pinned Agent SDK version, for Claude only. */
  sdkVersion: z.string().nullable(),
  /** A short identity of what was checked, such as `codex 0.163.0` or `claude 2.1.302 sdk 0.3.302`. */
  fingerprint: z.string(),
  capabilities: z.array(capabilitySchema),
});
export type IntegrationHealth = z.infer<typeof integrationHealthSchema>;

export const healthReportSchema = z.object({
  checkedAt: z.string(),
  durationMs: z.number(),
  /** The Grampus version that ran the check. */
  application: z.string(),
  /** A digest of every integration fingerprint, so two reports of the same setup compare equal. */
  fingerprint: z.string(),
  integrations: z.array(integrationHealthSchema),
});
/** One complete `doctor` result. */
export type HealthReport = z.infer<typeof healthReportSchema>;
