// Owns the private endpoint receipt for a running desktop dashboard. This is disposable discovery,
// never workflow evidence. Only an authenticated, matching instance may be reused or shut down.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { desktopLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { applicationRoot, installedBuild } from '../config/runtime.js';
import { currentProcessStartedAt } from '../process/process-identity.js';
import { deepEqual } from '../domain/deep-equal.js';
import { processAlive } from '../verification/check-recovery.js';

const pathKey = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));

/** Identity stable across installed updates, distinct for every development checkout and journal. */
export interface DesktopProfile {
  application: string;
  db: string;
  directory: string;
}

/** The desktop profile of this copy, including an explicitly selected journal. */
export function desktopProfile(directory: string, db: string): DesktopProfile {
  return {
    application: pathKey(installedBuild?.installRoot ?? applicationRoot),
    db: pathKey(db),
    directory: resolve(directory),
  };
}

const endpointSchema = z.strictObject({
  schema: z.literal(1),
  instance: z.uuid(),
  application: z.string(),
  db: z.string(),
  host: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string().nullable(),
  url: z
    .string()
    .refine(value => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          url.pathname === '/' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          /^#[a-f0-9]{64}$/.test(url.hash)
        );
      } catch {
        return false;
      }
    })
    .nullable(),
});

/** Private access link bound to its exact server process and application profile. */
export type DesktopEndpoint = z.infer<typeof endpointSchema>;

/** Paths are keyed by journal and application, so explicit data overrides cannot mix profiles. */
export function desktopFiles(profile: DesktopProfile) {
  const key = createHash('sha256')
    .update(JSON.stringify([profile.application, profile.db]))
    .digest('hex');
  const base = join(profile.directory, 'desktop', key);
  return { receipt: `${base}.json`, lock: `${base}.sqlite`, log: `${base}.log` };
}

/** Reads one current-format receipt. Malformed or foreign records refuse launch rather than guessing. */
export function readDesktopEndpoint(profile: DesktopProfile): DesktopEndpoint | null {
  const path = desktopFiles(profile).receipt;
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).size > desktopLimits.discoveryBytes) throw new Error('Oversized receipt');
    const endpoint = endpointSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (endpoint.application !== profile.application || endpoint.db !== profile.db || endpoint.host !== hostname())
      throw new Error('Foreign receipt');
    return endpoint;
  } catch {
    throw new Error(`Dashboard discovery is invalid: ${path}. Inspect it before starting another dashboard.`);
  }
}

/** Publishes a private receipt after the loopback server has bound its port. */
export function publishDesktopEndpoint(
  profile: DesktopProfile,
  url: string | null,
  pid = process.pid,
): DesktopEndpoint {
  const previous = readDesktopEndpoint(profile);
  if (previous && previous.pid !== pid && processAlive(previous.pid, previous.startedAt))
    throw new Error('This journal already has a running or uncertain dashboard. Use grampus open to reconnect.');
  const endpoint = endpointSchema.parse({
    schema: 1,
    instance: randomUUID(),
    application: profile.application,
    db: profile.db,
    host: hostname(),
    pid,
    startedAt: pid === process.pid ? currentProcessStartedAt() : null,
    url,
  });
  const path = desktopFiles(profile).receipt;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${endpoint.instance}`;
  writeFileSync(temporary, JSON.stringify(endpoint), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  return endpoint;
}

/** Removes only this server's receipt; shutdown cannot erase a replacement endpoint. */
export function retireDesktopEndpoint(profile: DesktopProfile, endpoint: DesktopEndpoint): void {
  if (readDesktopEndpoint(profile)?.instance === endpoint.instance) unlinkSync(desktopFiles(profile).receipt);
}

/** Authenticated instance identity; contains no access token. */
export function desktopIdentity(endpoint: DesktopEndpoint) {
  return { instance: endpoint.instance, application: endpoint.application, db: endpoint.db, pid: endpoint.pid };
}

/** Calls only the receipt's loopback origin, with no redirect or unbounded response. */
export async function desktopRequest(endpoint: DesktopEndpoint, close = false): Promise<unknown> {
  if (!endpoint.url) throw new Error('Dashboard startup is still unconfirmed');
  const url = new URL(endpoint.url);
  const response = await fetch(`${url.origin}/api/desktop${close ? '/close' : ''}`, {
    method: close ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(currentSettings().dashboardProbeMs),
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, ...(close ? { 'Content-Type': 'application/json' } : {}) },
    ...(close ? { body: JSON.stringify({ instance: endpoint.instance }) } : {}),
  });
  if (!response.ok)
    throw new Error(
      close ? 'The dashboard refused shutdown; work may still be active.' : 'Dashboard identity was refused',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Dashboard identity is missing');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > desktopLimits.responseBytes) throw new Error('Dashboard response is too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Whether the live server proves this receipt's exact identity. An unknown response is never success. */
export async function desktopResponds(endpoint: DesktopEndpoint): Promise<boolean> {
  try {
    return deepEqual(await desktopRequest(endpoint), desktopIdentity(endpoint));
  } catch {
    return false;
  }
}
